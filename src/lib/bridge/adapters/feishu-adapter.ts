/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue (same pattern as Telegram).
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import crypto from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
} from '../markdown/feishu.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';

/** State for an active CardKit v2 streaming card. */
interface FeishuCardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

/** Streaming card throttle interval (ms). */
const CARD_THROTTLE_MS = 200;

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  /** Active streaming card state per chatId. */
  private activeCards = new Map<string, FeishuCardState>();
  /** In-flight card creation promises per chatId — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    // Create EventDispatcher and register event handlers.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
    });

    // Create and start WSClient
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
    });

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu-adapter] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator (Openclaw-style reaction) ─────────────

  /**
   * Add a "Typing" emoji reaction to the user's message and create streaming card.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Create streaming card (fire-and-forget — fallback to traditional if fails)
    if (messageId) {
      this.createStreamingCard(chatId, messageId).catch(() => {});
    }

    // Typing indicator (same as before)
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Remove the "Typing" emoji reaction and clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string): void {
    // Clean up any orphaned card state (normally cleaned by finalizeCard)
    this.cleanupCard(chatId);

    // Remove typing reaction (same as before)
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * Handle card.action.trigger events (button clicks on permission cards).
   * Converts button clicks to synthetic InboundMessage with callbackData.
   * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };

    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      // Extract chat/user context
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      if (!chatId) return FALLBACK_TOAST;

      const callbackMsg: import('../types.js').InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: {
          channelType: 'feishu',
          chatId,
          userId,
        },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      };
      this.enqueue(callbackMsg);

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────────

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);

    // In-flight guard: if creation is already in progress, return the existing promise
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient) return false;

    try {
      // Step 1: Create card via CardKit v2
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: '💭 Thinking...',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await (this.restClient as any).cardkit.v2.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Card create returned no card_id');
        return false;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-adapter] Card message send returned no message_id');
        return false;
      }

      // Store card state
      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
      });

      console.log(`[feishu-adapter] Streaming card created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Update streaming card content with throttling.
   */
  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    // Clear thinking state once text arrives
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      // Schedule trailing-edge flush
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.flushCardUpdate(chatId);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    // Clear pending timer and flush immediately
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushCardUpdate(chatId);
  }

  /**
   * Flush pending card update to Feishu API.
   */
  private flushCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    const content = buildStreamingContent(state.pendingText || '', state.toolCalls);

    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;

    // Fire-and-forget — streaming updates are non-critical
    (this.restClient as any).cardkit.v2.card.streamContent({
      path: { card_id: cardId },
      data: { content, sequence: seq },
    }).then(() => {
      state.lastUpdateAt = Date.now();
    }).catch((err: unknown) => {
      console.warn('[feishu-adapter] streamContent failed:', err instanceof Error ? err.message : err);
    });
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.toolCalls = tools;
    // Trigger a content flush with current text + updated tools
    this.updateCardContent(chatId, state.pendingText || '');
  }

  /**
   * Finalize the streaming card: close streaming mode, update with final content + footer.
   */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
  ): Promise<boolean> {
    // Wait for in-flight card creation to complete before finalizing
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* creation failed — no card to finalize */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return false;

    // Clear any pending throttle timer
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      // Step 1: Close streaming mode
      state.sequence++;
      await (this.restClient as any).cardkit.v2.card.settings.streamingMode.set({
        path: { card_id: state.cardId },
        data: { streaming_mode: false, sequence: state.sequence },
      });

      // Step 2: Build and apply final card
      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      const finalCardJson = buildFinalCardJson(responseText, state.toolCalls, footer);

      state.sequence++;
      await (this.restClient as any).cardkit.v2.card.update({
        path: { card_id: state.cardId },
        data: { type: 'card_json', data: finalCardJson, sequence: state.sequence },
      });

      console.log(`[feishu-adapter] Card finalized: cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.activeCards.delete(chatId);
    }
  }

  /**
   * Clean up card state without finalizing (e.g. on unexpected errors).
   */
  private cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }
    this.activeCards.delete(chatId);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string): void {
    if (!this.activeCards.has(chatId)) {
      // Card should have been created by onMessageStart, but create lazily if not
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    this.updateToolProgress(chatId, tools);
  }

  async onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string): Promise<boolean> {
    return this.finalizeCard(chatId, status, responseText);
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text);
    }
    return this.sendAsPost(message.address.chatId, text);
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Convert HTML text from permission-broker to Feishu markdown.
    // permission-broker sends HTML (<b>, <code>, <pre>, &amp; entities)
    // but Feishu card markdown elements don't understand HTML.
    const mdText = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extract permissionRequestId from the first button's callback data
    const firstBtn = inlineButtons.flat()[0];
    const permId = firstBtn?.callbackData?.startsWith('perm:')
      ? firstBtn.callbackData.split(':').slice(2).join(':')
      : '';

    if (permId) {
      // Use real card action buttons
      const cardJson = buildPermissionButtonCard(mdText, permId, chatId);

      try {
        const res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        });
        if (res?.data?.message_id) {
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn('[feishu-adapter] Permission button card send failed:', JSON.stringify({ code: (res as any)?.code, msg: res?.msg }));
      } catch (err) {
        console.warn('[feishu-adapter] Permission button card error, falling back to text:', err instanceof Error ? err.message : err);
      }
    }

    // Fallback: text-based permission commands (same as before, for backward compat)
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        return `\`/perm ${action} ${id}\``;
      }
      return btn.text;
    });

    const cardContent = [
      mdText,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Fallback card also failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Fallback card error, sending plain text:', err instanceof Error ? err.message : err);
    }

    // Last resort: plain text message (works even without card permissions)
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
      '',
      ...permCommands,
    ].join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: plainText }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: 'feishu',
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
