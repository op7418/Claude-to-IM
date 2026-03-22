/**
 * Discord Adapter — implements BaseChannelAdapter for Discord Bot API.
 *
 * Uses discord.js v14 Client with Gateway intents for real-time message
 * consumption, and REST API for message sending. Routes messages through
 * an internal async queue (same pattern as Telegram and Feishu).
 *
 * IMPORTANT: discord.js is loaded via dynamic import() to avoid Next.js
 * bundler trying to resolve native modules (zlib-sync, bufferutil) at
 * build time. All discord.js types are referenced via `any` at the class
 * level and resolved at runtime in start().
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';



/** Discord message character limit. */
const DISCORD_CHAR_LIMIT = 2000;

/** Default max attachment download size (20 MB). */
const DEFAULT_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/** Typing indicator interval (8s, Discord typing lasts ~10s). */
const TYPING_INTERVAL_MS = 8000;

/** Interaction TTL for answerCallback (60s). */
const INTERACTION_TTL_MS = 60_000;

/**
 * Lazily loaded discord.js module reference.
 * Populated in start() via dynamic import to avoid bundler issues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let discordJs: any = null;

async function loadDiscordJs() {
  if (!discordJs) {
    discordJs = await import('discord.js');
  }
  return discordJs;
}

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'discord';

  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  // Inbound dedup now uses persistent store (survives process restarts)
  private botUserId: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Temporary storage for Interaction objects (for answerCallback). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingInteractions = new Map<string, { interaction: any; expiresAt: number }>();
  /** Preview: store message IDs per chat for edit-based streaming. */
  private previewMessages = new Map<string, string>();
  /** Chats where preview has permanently failed. */
  private previewDegraded = new Set<string>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[discord-adapter] Cannot start:', configError);
      return;
    }

    const token = getBridgeContext().store.getSetting('bridge_discord_bot_token') || '';

    // Dynamic import to avoid bundler resolving native modules
    const djs = await loadDiscordJs();
    const { Client, GatewayIntentBits, Partials } = djs;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    // Register event handlers before login
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('messageCreate', (message: any) => {
      this.handleMessageCreate(message).catch((err: unknown) => {
        console.error('[discord-adapter] messageCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('interactionCreate', (interaction: any) => {
      this.handleInteraction(interaction).catch((err: unknown) => {
        console.error('[discord-adapter] interactionCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // Login and wait for ready
    await this.client.login(token);

    // Wait for the ready event
    await new Promise<void>((resolve) => {
      if (this.client!.isReady()) {
        resolve();
      } else {
        this.client!.once('ready', () => resolve());
      }
    });

    this.botUserId = this.client.user?.id || null;
    this.running = true;

    console.log('[discord-adapter] Started (botUserId:', this.botUserId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Destroy client
    if (this.client) {
      try {
        this.client.destroy();
      } catch (err) {
        console.warn('[discord-adapter] Client destroy error:', err instanceof Error ? err.message : err);
      }
      this.client = null;
    }

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Stop all typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear state
    this.pendingInteractions.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();

    console.log('[discord-adapter] Stopped');
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

  // ── Typing indicator ───────────────────────────────────────

  onMessageStart(chatId: string): void {
    this.stopTyping(chatId);
    if (!this.client) return;

    const sendTyping = () => {
      const channel = this.client?.channels.cache.get(chatId);
      if (channel && 'sendTyping' in channel) {
        channel.sendTyping().catch(() => {});
      }
    };

    // Send immediately
    sendTyping();

    // Repeat every 8s
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.typingIntervals.set(chatId, interval);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) {
      return { ok: false, error: 'Discord client not initialized' };
    }

    let channel = this.client.channels.cache.get(message.address.chatId);
    if (!channel || !('send' in channel)) {
      // Try fetching the channel if not in cache
      try {
        channel = await this.client.channels.fetch(message.address.chatId);
        if (!channel || !('send' in channel)) {
          return { ok: false, error: 'Channel not found or not sendable' };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Channel fetch failed' };
      }
    }

    return this.sendToChannel(channel, message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sendToChannel(channel: any, message: OutboundMessage): Promise<SendResult> {
    try {
      let text = message.text;

      // Convert HTML to Discord markdown
      if (message.parseMode === 'HTML') {
        text = this.htmlToDiscordMarkdown(text);
      }
      // Markdown passes through natively

      // Build message options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: { content: string; components?: any[] } = {
        content: text.slice(0, DISCORD_CHAR_LIMIT),
      };

      // Build inline buttons as Discord components
      if (message.inlineButtons && message.inlineButtons.length > 0 && discordJs) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discordJs;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = [];
        for (const row of message.inlineButtons) {
          const actionRow = new ActionRowBuilder();
          for (const btn of row) {
            actionRow.addComponents(
              new ButtonBuilder()
                .setCustomId(btn.callbackData)
                .setLabel(btn.text)
                .setStyle(ButtonStyle.Primary),
            );
          }
          rows.push(actionRow);
        }
        options.components = rows;
      }

      const sent = await channel.send(options);
      return { ok: true, messageId: sent.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const entry = this.pendingInteractions.get(callbackQueryId);
    if (!entry) return;

    this.pendingInteractions.delete(callbackQueryId);

    try {
      const interaction = entry.interaction;
      if (interaction.isButton() && !interaction.replied) {
        await interaction.editReply({ content: text || 'OK' });
      }
    } catch {
      // Interaction may have expired — non-critical
    }
  }

  // ── Streaming preview ──────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    // Global kill switch
    if (getBridgeContext().store.getSetting('bridge_discord_stream_enabled') === 'false') return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.client) return 'skip';

    const existingMsgId = this.previewMessages.get(chatId);

    try {
      if (existingMsgId) {
        // Edit existing preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('messages' in channel)) return 'skip';

        const msg = await channel.messages.fetch(existingMsgId);
        await msg.edit(text.slice(0, DISCORD_CHAR_LIMIT));
        return 'sent';
      } else {
        // Send new preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('send' in channel)) return 'skip';

        const sent = await channel.send(text.slice(0, DISCORD_CHAR_LIMIT));
        this.previewMessages.set(chatId, sent.id);
        return 'sent';
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.httpStatus;
      if (code === 403 || code === 404) {
        this.previewDegraded.add(chatId);
        return 'degrade';
      }
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number): void {
    const msgId = this.previewMessages.get(chatId);
    if (msgId && this.client) {
      // Delete the preview message — the final response replaces it
      const channel = this.client.channels.cache.get(chatId);
      if (channel && 'messages' in channel) {
        channel.messages.fetch(msgId).then((msg: { delete: () => void }) => msg.delete()).catch(() => {});
      }
    }
    this.previewMessages.delete(chatId);
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_discord_enabled');
    if (enabled !== 'true') return 'bridge_discord_enabled is not true';

    const token = getBridgeContext().store.getSetting('bridge_discord_bot_token');
    if (!token) return 'bridge_discord_bot_token not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_discord_allowed_users') || '';
    const allowedChannels = getBridgeContext().store.getSetting('bridge_discord_allowed_channels') || '';

    // If both are empty, deny all (security-first, default-deny)
    if (!allowedUsers && !allowedChannels) return false;

    const users = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    const channels = allowedChannels.split(',').map(s => s.trim()).filter(Boolean);

    // If users list is configured, check if user is in it
    if (users.length > 0 && users.includes(userId)) return true;

    // If channels list is configured, check if chat is in it
    if (channels.length > 0 && channels.includes(chatId)) return true;

    // If only one list is configured and the other is empty, check only the configured one
    if (users.length > 0 && channels.length === 0) return false;
    if (channels.length > 0 && users.length === 0) return false;

    return false;
  }

  // ── Incoming event handlers ────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessageCreate(message: any): Promise<void> {
    try {
      await this.processMessage(message);
    } catch (err) {
      console.error(
        '[discord-adapter] Unhandled error in message handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processMessage(message: any): Promise<void> {
    // Filter out bot messages (including self)
    if (message.author.bot) return;
    if (this.botUserId && message.author.id === this.botUserId) return;

    // Dedup by message ID — persistent via store (survives process restarts)
    const store = getBridgeContext().store;
    if (store.checkDedup(message.id)) return;
    store.insertDedup(message.id);

    const chatId = message.channelId;
    const userId = message.author.id;
    const displayName = message.author.username || message.author.id;
    const isGuild = !!message.guild;

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) return;

    // Guild (server) message policy
    if (isGuild) {
      const allowedGuilds = (getBridgeContext().store.getSetting('bridge_discord_allowed_guilds') || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      if (allowedGuilds.length > 0 && !allowedGuilds.includes(message.guild!.id)) {
        return;
      }

      const policy = getBridgeContext().store.getSetting('bridge_discord_group_policy') || 'open';

      if (policy === 'disabled') {
        return;
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_discord_require_mention') === 'true';
      if (requireMention && this.botUserId) {
        // Check both user @mention and role @mention (bot's managed role)
        const userMentioned = message.mentions.users.has(this.botUserId);
        const botMember = message.guild?.members?.cache?.get(this.botUserId);
        const botRoles = botMember?.roles?.cache;
        const roleMentioned = botRoles
          ? message.mentions.roles.some((r: { id: string }) => botRoles.has(r.id))
          : false;
        // Also check raw content for <@botId> or <@&roleId> patterns
        const rawContentMention = message.content?.includes(`<@${this.botUserId}>`)
          || message.content?.includes(`<@!${this.botUserId}>`);
        const mentioned = userMentioned || roleMentioned || rawContentMention;
        if (!mentioned) {
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'discord',
              chatId,
              direction: 'inbound',
              messageId: message.id,
              summary: '[FILTERED] Guild message dropped: bot not @mentioned (require_mention=true)',
            });
          } catch { /* best effort */ }
          return;
        }
      }
    }

    // Extract text content
    let text = message.content || '';

    // Strip bot user mention and bot role mention from text
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }
    // Strip bot's managed role mentions
    if (message.guild && this.botUserId) {
      const botMember = message.guild.members?.cache?.get(this.botUserId);
      if (botMember?.roles?.cache) {
        for (const [roleId] of botMember.roles.cache) {
          text = text.replace(new RegExp(`<@&${roleId}>`, 'g'), '').trim();
        }
      }
    }

    // Normalize ! commands to / commands
    if (text.startsWith('!')) {
      text = '/' + text.slice(1);
    }

    // Handle attachments (images)
    const attachments: FileAttachment[] = [];
    const imageEnabled = getBridgeContext().store.getSetting('bridge_discord_image_enabled') !== 'false';
    const maxSize = parseInt(getBridgeContext().store.getSetting('bridge_discord_max_attachment_size') || '', 10) || DEFAULT_MAX_ATTACHMENT_SIZE;

    if (imageEnabled && message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        if (!attachment.contentType?.startsWith('image/')) continue;
        if (attachment.size > maxSize) {
          console.warn(`[discord-adapter] Attachment too large (${attachment.size} > ${maxSize}), skipping`);
          continue;
        }

        try {
          const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;

          const buffer = Buffer.from(await res.arrayBuffer());
          const base64 = buffer.toString('base64');
          const id = crypto.randomUUID();

          attachments.push({
            id,
            name: attachment.name || `image.${attachment.contentType?.split('/')[1] || 'png'}`,
            type: attachment.contentType || 'image/png',
            size: buffer.length,
            data: base64,
          });
        } catch (err) {
          console.warn('[discord-adapter] Attachment download failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    const address = {
      channelType: 'discord' as const,
      chatId,
      userId,
      displayName,
    };

    const inbound: InboundMessage = {
      messageId: message.id,
      address,
      text: text.trim(),
      timestamp: message.createdTimestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'discord',
        chatId,
        direction: 'inbound',
        messageId: message.id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleInteraction(interaction: any): Promise<void> {
    if (!interaction.isButton()) return;

    try {
      // Defer immediately to avoid 3s timeout
      await interaction.deferUpdate();
    } catch {
      // Interaction may already be handled
      return;
    }

    const callbackData = interaction.customId;
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) return;

    // Store interaction for answerCallback with TTL
    const interactionId = `discord-${interaction.id}`;
    this.pendingInteractions.set(interactionId, {
      interaction,
      expiresAt: Date.now() + INTERACTION_TTL_MS,
    });

    // Clean up expired interactions
    this.cleanupExpiredInteractions();

    const inbound: InboundMessage = {
      messageId: interactionId,
      address: {
        channelType: 'discord',
        chatId,
        userId,
        displayName,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId: interaction.message?.id,
    };

    this.enqueue(inbound);
  }

  // ── Utilities ───────────────────────────────────────────────

  // addToDedup removed — now using persistent store.insertDedup()

  private cleanupExpiredInteractions(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingInteractions) {
      if (entry.expiresAt < now) {
        this.pendingInteractions.delete(id);
      }
    }
  }

  /**
   * Convert simple HTML tags to Discord markdown.
   * Handles the common tags used in bridge-manager command responses.
   */
  private htmlToDiscordMarkdown(html: string): string {
    return html
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''); // Strip remaining HTML tags
  }
}

// Self-register so bridge-manager can create DiscordAdapter via the registry.
registerAdapterFactory('discord', () => new DiscordAdapter());
