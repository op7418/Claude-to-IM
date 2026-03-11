/**
 * DingTalk Adapter — implements BaseChannelAdapter for DingTalk Stream Mode.
 *
 * Uses the official dingtalk-stream SDK to receive robot callbacks over
 * WebSocket. Outbound replies are sent through the sessionWebhook attached to
 * the latest inbound message for each conversation.
 *
 * Notes:
 * - DingTalk sessionWebhook expires, so replies only work after a recent
 *   inbound message refreshed the webhook for the chat.
 * - DingTalk does not support inline callback buttons through sessionWebhook,
 *   so permission prompts fall back to text commands in bridge-manager /
 *   permission-broker.
 */

import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage,
} from 'dingtalk-stream';
import type {
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import { normalizeDingtalkMarkdown } from '../markdown/dingtalk.js';

const DEDUP_MAX = 1000;
const SESSION_CACHE_MAX = 500;
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

interface DingtalkAtUser {
  dingtalkId?: string;
  staffId?: string;
}

type DingtalkRobotMessage = Omit<RobotMessage, 'text'> & {
  atUsers?: DingtalkAtUser[];
  content?: unknown;
  conversationTitle?: string;
  isInAtList?: boolean;
  robotCode?: string;
  text?: {
    content?: unknown;
  };
};

interface ReplySession {
  sessionWebhook: string;
  expiresAt: number;
}

interface ParsedInboundMessage {
  text: string;
  attachments: FileAttachment[];
  imageDownloadFailed?: boolean;
  failedCount?: number;
}

interface SessionWebhookResponse {
  ok: boolean;
  error?: string;
  httpStatus?: number;
  messageId?: string;
}

type DingtalkOutboundBody =
  | { msgtype: 'text'; text: { content: string } }
  | { msgtype: 'markdown'; markdown: { title: string; text: string } };

export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'dingtalk';

  private running = false;
  private client: DWClient | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Map<string, boolean>();
  private replySessions = new Map<string, ReplySession>();
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[dingtalk-adapter] Cannot start:', configError);
      return;
    }

    const store = getBridgeContext().store;
    const clientId = store.getSetting('bridge_dingtalk_client_id') || '';
    const clientSecret = store.getSetting('bridge_dingtalk_client_secret') || '';
    const debug = store.getSetting('bridge_dingtalk_debug') === 'true';

    this.client = new DWClient({
      clientId,
      clientSecret,
      debug,
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      void this.handleRobotCallback(event);
    });

    await this.client.connect();
    this.running = true;

    console.log('[dingtalk-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {
        console.warn('[dingtalk-adapter] Disconnect error:', err instanceof Error ? err.message : err);
      }
      this.client = null;
    }

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    this.replySessions.clear();
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;

    console.log('[dingtalk-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const replySession = this.replySessions.get(message.address.chatId);
    if (!replySession) {
      return { ok: false, error: 'No active DingTalk sessionWebhook for this chat' };
    }

    if (Date.now() >= replySession.expiresAt) {
      this.replySessions.delete(message.address.chatId);
      return { ok: false, error: 'DingTalk sessionWebhook expired' };
    }

    const body = this.buildOutboundBody(message);
    this.debugLog(
      `Sending reply chatId=${message.address.chatId} parseMode=${message.parseMode || 'plain'} ` +
      `msgtype=${body.msgtype} textLength=${message.text.length}`,
    );

    let result = await this.postSessionWebhook(replySession.sessionWebhook, body);

    // SessionWebhook normally works without extra auth, but some deployments
    // still expect the access token header. Retry once with a fresh token.
    if (!result.ok && this.shouldRetryWithAccessToken(result)) {
      try {
        const accessToken = await this.getAccessToken();
        if (accessToken) {
          result = await this.postSessionWebhook(replySession.sessionWebhook, body, accessToken);
        }
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to refresh DingTalk access token',
        };
      }
    }

    this.debugLog(
      `Reply result chatId=${message.address.chatId} ok=${result.ok} ` +
      `${result.error ? `error=${result.error}` : ''}`.trim(),
    );
    return result;
  }

  validateConfig(): string | null {
    const store = getBridgeContext().store;

    const enabled = store.getSetting('bridge_dingtalk_enabled');
    if (enabled !== 'true') return 'bridge_dingtalk_enabled is not true';

    const clientId = store.getSetting('bridge_dingtalk_client_id');
    if (!clientId) return 'bridge_dingtalk_client_id not configured';

    const clientSecret = store.getSetting('bridge_dingtalk_client_secret');
    if (!clientSecret) return 'bridge_dingtalk_client_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_dingtalk_allowed_users') || '';
    if (!allowedUsers) return true;

    const allowed = allowedUsers
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;
    if (allowed.includes('*')) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private async handleRobotCallback(event: DWClientDownStream): Promise<void> {
    let acked = false;
    try {
      const payload = JSON.parse(event.data) as DingtalkRobotMessage;
      this.ackCallback(event.headers.messageId);
      acked = true;
      await this.processRobotMessage(event, payload);
    } catch (err) {
      console.error('[dingtalk-adapter] Failed to handle robot callback:', err instanceof Error ? err.message : err);
    } finally {
      if (!acked) {
        this.ackCallback(event.headers.messageId);
      }
    }
  }

  private async processRobotMessage(event: DWClientDownStream, payload: DingtalkRobotMessage): Promise<void> {
    const messageId = payload.msgId || event.headers.messageId;
    if (!messageId) return;

    if (this.seenMessageIds.has(messageId)) return;
    this.addToDedup(messageId);

    const chatId = payload.conversationId;
    const userId = payload.senderStaffId || payload.senderId || '';
    if (!chatId) return;

    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[dingtalk-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    if (this.isGroupConversation(payload.conversationType)) {
      const groupPolicy = getBridgeContext().store.getSetting('bridge_dingtalk_group_policy') || 'open';

      if (groupPolicy === 'disabled') {
        return;
      }

      if (groupPolicy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_dingtalk_group_allow_from') || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);

        if (!allowedGroups.includes(chatId)) {
          return;
        }
      }

      const requireMention = getBridgeContext().store.getSetting('bridge_dingtalk_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(payload)) {
        this.debugLog(`Ignored group message without @mention chatId=${chatId} msgId=${messageId}`);
        return;
      }
    }

    if (payload.sessionWebhook) {
      this.setReplySession(chatId, {
        sessionWebhook: payload.sessionWebhook,
        expiresAt: this.parseTimestamp(payload.sessionWebhookExpiredTime),
      });
    }

    const parsed = await this.extractInboundMessage(payload);
    const text = parsed.text.trim();
    this.debugLog(
      `Incoming msgId=${messageId} chatId=${chatId} userId=${userId} msgtype=${payload.msgtype} ` +
      `textLength=${text.length} attachments=${parsed.attachments.length}`,
    );
    if (!text && parsed.attachments.length === 0 && !parsed.imageDownloadFailed) return;

    this.enqueue({
      messageId,
      address: {
        channelType: 'dingtalk',
        chatId,
        userId,
        displayName: payload.senderNick || payload.conversationTitle,
      },
      text,
      timestamp: this.parseTimestamp(payload.createAt),
      attachments: parsed.attachments.length > 0 ? parsed.attachments : undefined,
      raw: {
        headers: event.headers,
        payload,
        imageDownloadFailed: parsed.imageDownloadFailed,
        failedCount: parsed.failedCount,
      },
    });
  }

  private ackCallback(messageId: string): void {
    if (!messageId) return;

    try {
      this.client?.socketCallBackResponse(messageId, {});
    } catch (err) {
      console.warn('[dingtalk-adapter] Failed to ack callback:', err instanceof Error ? err.message : err);
    }
  }

  private buildOutboundBody(message: OutboundMessage): DingtalkOutboundBody {
    const buttonsText = this.renderInlineButtons(message.inlineButtons);
    const parseMode = message.parseMode || 'plain';

    if (parseMode === 'Markdown') {
      const markdownText = normalizeDingtalkMarkdown(
        [message.text.trim(), buttonsText].filter(Boolean).join('\n\n'),
      );
      return {
        msgtype: 'markdown',
        markdown: {
          title: this.buildMarkdownTitle(markdownText),
          text: markdownText,
        },
      };
    }

    const plainText = parseMode === 'HTML'
      ? this.htmlToPlainText(message.text)
      : message.text;

    const content = [plainText.trim(), buttonsText].filter(Boolean).join('\n\n');

    return {
      msgtype: 'text',
      text: {
        content,
      },
    };
  }

  private async extractInboundMessage(payload: DingtalkRobotMessage): Promise<ParsedInboundMessage> {
    const attachments: FileAttachment[] = [];
    const richTextItems = this.extractRichTextItems(payload.content);
    const richTextParts: string[] = [];
    const topLevelText = this.normalizeTextValue(payload.text?.content);
    let failedCount = 0;

    for (const item of richTextItems) {
      const itemText = this.extractTextFromNode(item);
      if (itemText && !this.isPlaceholderText(itemText)) {
        richTextParts.push(itemText);
      }

      const downloadCode = this.extractDownloadCode(item);
      if (!downloadCode || !payload.robotCode) continue;

      const attachment = await this.downloadAttachment(
        downloadCode,
        payload.robotCode,
        this.mapAttachmentKind(item.type),
        item,
      );

      if (attachment) {
        attachments.push(attachment);
      } else if (this.isImageKind(item.type)) {
        failedCount += 1;
      }
    }

    if (attachments.length === 0) {
      const downloadCode = this.extractDownloadCode(payload.content);
      if (downloadCode && payload.robotCode) {
        const attachment = await this.downloadAttachment(
          downloadCode,
          payload.robotCode,
          this.mapAttachmentKind(payload.msgtype),
          this.normalizeNode(payload.content),
        );

        if (attachment) {
          attachments.push(attachment);
        } else if (this.isImageKind(payload.msgtype)) {
          failedCount += 1;
        }
      }
    }

    const contentFallbackText = this.extractPlainTextFromContent(payload.content);
    const richHasText = richTextParts.length > 0;
    const textParts = richHasText ? richTextParts : [];
    if (topLevelText && !richHasText && !this.isPlaceholderText(topLevelText)) {
      textParts.push(topLevelText);
    }
    if (contentFallbackText && textParts.length === 0 && !this.isPlaceholderText(contentFallbackText)) {
      textParts.push(contentFallbackText);
    }

    return {
      text: this.joinTextParts(textParts),
      attachments,
      imageDownloadFailed: failedCount > 0 ? true : undefined,
      failedCount: failedCount > 0 ? failedCount : undefined,
    };
  }

  private renderInlineButtons(buttons?: OutboundMessage['inlineButtons']): string {
    if (!buttons || buttons.length === 0) return '';

    const lines = ['Actions:'];
    for (const row of buttons) {
      for (const button of row) {
        lines.push(`- ${button.text}`);
      }
    }
    return lines.join('\n');
  }

  private buildMarkdownTitle(text: string): string {
    const firstLine = text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || 'Claude-to-IM';

    const normalized = firstLine
      .replace(/^[#>*`\-\s]+/, '')
      .replace(/[*_~`[\]()]/g, '')
      .slice(0, 64)
      .trim();

    return normalized || 'Claude-to-IM';
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\'')
      .trim();
  }

  private normalizeNode(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private normalizeTextValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'content' in (value as Record<string, unknown>)) {
      const nested = (value as Record<string, unknown>).content;
      return typeof nested === 'string' ? nested : '';
    }
    return '';
  }

  private extractPlainTextFromContent(rawContent: unknown): string {
    if (typeof rawContent === 'string') {
      const trimmed = rawContent.trim();
      if (!trimmed) return '';
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return this.extractPlainTextFromContent(JSON.parse(trimmed));
        } catch {
          return rawContent;
        }
      }
      return rawContent;
    }

    const node = this.normalizeNode(rawContent);
    return this.extractTextFromNode(node);
  }

  private extractRichTextItems(rawContent: unknown): Array<Record<string, unknown>> {
    const node = typeof rawContent === 'string'
      ? this.normalizeNode(this.tryParseJson(rawContent))
      : this.normalizeNode(rawContent);

    const raw = node.richText || node.rich_text;
    if (!Array.isArray(raw)) return [];

    return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }

  private extractTextFromNode(node: unknown): string {
    const record = this.normalizeNode(node);
    const directText = record.text;
    if (typeof directText === 'string') return directText;
    if (directText && typeof directText === 'object' && typeof (directText as Record<string, unknown>).content === 'string') {
      return (directText as Record<string, unknown>).content as string;
    }

    const content = record.content;
    if (typeof content === 'string') return content;

    return '';
  }

  private extractDownloadCode(node: unknown): string {
    const record = this.normalizeNode(typeof node === 'string' ? this.tryParseJson(node) : node);
    const value = record.downloadCode
      || record.download_code
      || record.pictureDownloadCode
      || record.picture_download_code;
    return typeof value === 'string' ? value.trim() : '';
  }

  private mapAttachmentKind(value: unknown): 'image' | 'audio' | 'video' | 'file' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'picture' || normalized === 'image') return 'image';
    if (normalized === 'voice' || normalized === 'audio') return 'audio';
    if (normalized === 'video') return 'video';
    return 'file';
  }

  private isImageKind(value: unknown): boolean {
    return this.mapAttachmentKind(value) === 'image';
  }

  private isPlaceholderText(value: string): boolean {
    const trimmed = value.trim();
    return !trimmed || trimmed === '\\n' || trimmed === '//n';
  }

  private joinTextParts(parts: string[]): string {
    const normalized = parts
      .map((part) => part.trim())
      .filter(Boolean);
    return Array.from(new Set(normalized)).join('\n');
  }

  private tryParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private async downloadAttachment(
    downloadCode: string,
    robotCode: string,
    kind: 'image' | 'audio' | 'video' | 'file',
    node: Record<string, unknown>,
  ): Promise<FileAttachment | null> {
    const downloadUrl = await this.getMessageFileDownloadUrl(downloadCode, robotCode);
    if (!downloadUrl) return null;
    this.debugLog(`Downloading attachment kind=${kind} downloadCode=${downloadCode}`);

    const response = await fetch(downloadUrl);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE) return null;

    const headerMime = (response.headers.get('content-type') || '').split(';')[0].trim();
    const fallbackName = this.extractFilenameHint(node, kind);
    const mimeType = this.resolveMimeType(kind, headerMime, fallbackName);
    const fileName = this.ensureFilename(fallbackName, kind, mimeType);

    return {
      id: `dingtalk:${downloadCode}`,
      name: fileName,
      type: mimeType,
      size: buffer.length,
      data: buffer.toString('base64'),
      filePath: downloadUrl,
    };
  }

  private extractFilenameHint(node: Record<string, unknown>, kind: 'image' | 'audio' | 'video' | 'file'): string {
    const candidates = ['fileName', 'file_name', 'filename', 'name', 'title'];
    for (const key of candidates) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    switch (kind) {
      case 'image': return 'image.png';
      case 'audio': return 'audio.amr';
      case 'video': return 'video.mp4';
      default: return 'file.bin';
    }
  }

  private resolveMimeType(
    kind: 'image' | 'audio' | 'video' | 'file',
    headerMime: string,
    fileName: string,
  ): string {
    if (headerMime) return headerMime;
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.amr')) return 'audio/amr';
    if (kind === 'image') return 'image/png';
    if (kind === 'video') return 'video/mp4';
    if (kind === 'audio') return 'audio/amr';
    return 'application/octet-stream';
  }

  private ensureFilename(
    fileName: string,
    kind: 'image' | 'audio' | 'video' | 'file',
    mimeType: string,
  ): string {
    if (fileName.includes('.')) return fileName;
    if (mimeType === 'image/png') return `${fileName}.png`;
    if (mimeType === 'image/jpeg') return `${fileName}.jpg`;
    if (mimeType === 'image/gif') return `${fileName}.gif`;
    if (mimeType === 'image/webp') return `${fileName}.webp`;
    if (mimeType === 'video/mp4') return `${fileName}.mp4`;
    if (mimeType === 'audio/amr') return `${fileName}.amr`;
    if (kind === 'image') return `${fileName}.png`;
    if (kind === 'video') return `${fileName}.mp4`;
    if (kind === 'audio') return `${fileName}.amr`;
    return `${fileName}.bin`;
  }

  private async getMessageFileDownloadUrl(downloadCode: string, robotCode: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    this.debugLog(`Resolving download URL downloadCode=${downloadCode}`);

    const response = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({
        downloadCode,
        robotCode,
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      return null;
    }

    const record = payload as Record<string, unknown>;
    return this.pickStringField(record, ['downloadUrl', 'url'])
      || this.pickStringField(this.normalizeNode(record.result), ['downloadUrl', 'url'])
      || null;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const store = getBridgeContext().store;
    const appKey = store.getSetting('bridge_dingtalk_client_id') || '';
    const appSecret = store.getSetting('bridge_dingtalk_client_secret') || '';
    if (!appKey || !appSecret) {
      throw new Error('bridge_dingtalk_client_id or bridge_dingtalk_client_secret not configured');
    }

    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        appKey,
        appSecret,
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new Error(`Failed to get DingTalk access token: HTTP ${response.status}`);
    }

    const record = payload as Record<string, unknown>;
    const accessToken = this.pickStringField(record, ['accessToken', 'access_token']);
    if (!accessToken) {
      throw new Error('DingTalk access token not found in response');
    }

    this.accessToken = accessToken;
    this.accessTokenExpiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    this.debugLog('Refreshed DingTalk access token');
    return accessToken;
  }

  private isDebugEnabled(): boolean {
    return getBridgeContext().store.getSetting('bridge_dingtalk_debug') === 'true';
  }

  private debugLog(message: string): void {
    if (!this.isDebugEnabled()) return;
    console.log(`[dingtalk-adapter] ${message}`);
  }

  private isGroupConversation(conversationType: string): boolean {
    return String(conversationType) === '2';
  }

  private isBotMentioned(payload: DingtalkRobotMessage): boolean {
    if (payload.isInAtList === false) return false;
    return true;
  }

  private parseTimestamp(value: number | string | undefined): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private setReplySession(chatId: string, session: ReplySession): void {
    this.replySessions.set(chatId, session);
    while (this.replySessions.size > SESSION_CACHE_MAX) {
      const oldest = this.replySessions.keys().next().value;
      if (!oldest) break;
      this.replySessions.delete(oldest);
    }
  }

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    while (this.seenMessageIds.size > DEDUP_MAX) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (!oldest) break;
      this.seenMessageIds.delete(oldest);
    }
  }

  private shouldRetryWithAccessToken(result: SessionWebhookResponse): boolean {
    if (result.httpStatus === 401 || result.httpStatus === 403) return true;
    const error = result.error || '';
    return /token|unauthorized|permission|forbidden/i.test(error);
  }

  private async postSessionWebhook(
    url: string,
    body: DingtalkOutboundBody,
    accessToken?: string,
  ): Promise<SessionWebhookResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (accessToken) {
      headers['x-acs-dingtalk-access-token'] = accessToken;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => '');

      if (!response.ok) {
        return {
          ok: false,
          httpStatus: response.status,
          error: this.extractWebhookError(payload) || `HTTP ${response.status}`,
        };
      }

      const errcode = typeof payload === 'object' && payload !== null
        ? Number((payload as Record<string, unknown>).errcode)
        : 0;
      if (errcode && errcode !== 0) {
        return {
          ok: false,
          httpStatus: response.status,
          error: this.extractWebhookError(payload) || `DingTalk errcode ${errcode}`,
        };
      }

      const messageId = typeof payload === 'object' && payload !== null
        ? this.pickStringField(payload as Record<string, unknown>, ['messageId', 'msgId', 'processQueryKey'])
        : undefined;

      return { ok: true, messageId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'DingTalk sessionWebhook request failed',
      };
    }
  }

  private extractWebhookError(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return typeof payload === 'string' ? payload : undefined;
    }

    const record = payload as Record<string, unknown>;
    const message = this.pickStringField(record, ['errmsg', 'message', 'msg', 'errorMessage']);
    if (message) return message;

    const errcode = record.errcode;
    if (typeof errcode === 'number' || typeof errcode === 'string') {
      return `DingTalk errcode ${String(errcode)}`;
    }

    return undefined;
  }

  private pickStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return undefined;
  }
}

registerAdapterFactory('dingtalk', () => new DingTalkAdapter());
