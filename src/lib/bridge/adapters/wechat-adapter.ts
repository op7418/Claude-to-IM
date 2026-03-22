/**
 * WeChat Bot Adapter — implements BaseChannelAdapter for WeChat ClawBot ilink API.
 *
 * Private chat via ClawBot. Supports text + voice-to-text inbound messages
 * and text-only outbound.
 *
 * Uses HTTP long-polling (ilink/bot/getupdates) for real-time events
 * and REST API (ilink/bot/sendmessage) for sending replies.
 *
 * Token is obtained via QR code scan during setup and stored in bridge settings.
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  getUpdates,
  sendTextMessage,
  extractTextFromMessage,
  cacheContextToken,
  getCachedContextToken,
  clearContextTokenCache,
  MSG_TYPE_USER,
  DEFAULT_BASE_URL,
} from './wechat-api.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export class WeChatAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wechat';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Set<string>();
  private pollAbort: AbortController | null = null;
  private getUpdatesBuf = '';

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wechat-adapter] Cannot start:', configError);
      return;
    }

    this._running = true;
    this.pollAbort = new AbortController();

    // Start long-poll loop in background
    this.runPollLoop();

    console.log('[wechat-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }

    // Wake all waiters with null
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    clearContextTokenCache();

    console.log('[wechat-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this._running) return Promise.resolve(null);

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

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const store = getBridgeContext().store;
    const token = store.getSetting('bridge_wechat_token') || '';
    const baseUrl = store.getSetting('bridge_wechat_base_url') || DEFAULT_BASE_URL;

    const contextToken = getCachedContextToken(message.address.chatId);
    if (!contextToken) {
      return {
        ok: false,
        error: `No context_token for ${message.address.chatId}. The user needs to send a message first.`,
      };
    }

    // Strip HTML tags — WeChat doesn't render HTML
    let content = message.text;
    if (message.parseMode === 'HTML') {
      content = content.replace(/<[^>]+>/g, '');
    }

    return sendTextMessage(baseUrl, token, message.address.chatId, content, contextToken);
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const store = getBridgeContext().store;

    const token = store.getSetting('bridge_wechat_token');
    if (!token) return 'bridge_wechat_token not configured (run QR login setup first)';

    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_wechat_allowed_users') || '';
    if (!allowedUsers) return true;

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId);
  }

  // ── Long-poll loop ──────────────────────────────────────────

  private runPollLoop(): void {
    (async () => {
      const store = getBridgeContext().store;
      const token = store.getSetting('bridge_wechat_token') || '';
      const baseUrl = store.getSetting('bridge_wechat_base_url') || DEFAULT_BASE_URL;

      let consecutiveFailures = 0;

      while (this._running) {
        try {
          const resp = await getUpdates(baseUrl, token, this.getUpdatesBuf);

          // Handle API errors
          const isError =
            (resp.ret !== undefined && resp.ret !== 0) ||
            (resp.errcode !== undefined && resp.errcode !== 0);

          if (isError) {
            consecutiveFailures++;
            console.error(
              `[wechat-adapter] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
            );
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.error(
                `[wechat-adapter] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`,
              );
              consecutiveFailures = 0;
              await this.delay(BACKOFF_DELAY_MS);
            } else {
              await this.delay(RETRY_DELAY_MS);
            }
            continue;
          }

          consecutiveFailures = 0;

          // Save sync cursor
          if (resp.get_updates_buf) {
            this.getUpdatesBuf = resp.get_updates_buf;
          }

          // Process messages
          for (const msg of resp.msgs ?? []) {
            if (msg.message_type !== MSG_TYPE_USER) continue;

            const text = extractTextFromMessage(msg);
            if (!text) continue;

            const senderId = msg.from_user_id ?? 'unknown';

            // Dedup
            const msgKey = `${senderId}:${msg.client_id || msg.create_time_ms || ''}`;
            if (this.seenMessageIds.has(msgKey)) continue;
            this.seenMessageIds.add(msgKey);

            // Evict oldest when exceeding limit
            if (this.seenMessageIds.size > 1000) {
              const excess = this.seenMessageIds.size - 1000;
              let removed = 0;
              for (const key of this.seenMessageIds) {
                if (removed >= excess) break;
                this.seenMessageIds.delete(key);
                removed++;
              }
            }

            // Authorization check
            if (!this.isAuthorized(senderId, senderId)) {
              console.warn('[wechat-adapter] Unauthorized message from:', senderId);
              continue;
            }

            // Cache context token for reply
            if (msg.context_token) {
              cacheContextToken(senderId, msg.context_token);
            }

            const messageId = msg.client_id || crypto.randomUUID();
            const address = {
              channelType: 'wechat' as const,
              chatId: senderId,
              userId: senderId,
              displayName: senderId.split('@')[0] || senderId,
            };

            const inbound: InboundMessage = {
              messageId,
              address,
              text,
              timestamp: msg.create_time_ms || Date.now(),
            };

            this.enqueue(inbound);

            // Audit log
            try {
              getBridgeContext().store.insertAuditLog({
                channelType: 'wechat',
                chatId: senderId,
                direction: 'inbound',
                messageId,
                summary: text.slice(0, 200),
              });
            } catch { /* best effort */ }
          }
        } catch (err) {
          if (this.pollAbort?.signal.aborted) break;

          consecutiveFailures++;
          console.error('[wechat-adapter] Poll error:', err instanceof Error ? err.message : err);

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await this.delay(BACKOFF_DELAY_MS);
          } else {
            await this.delay(RETRY_DELAY_MS);
          }
        }
      }
    })().catch((err) => {
      if (!this.pollAbort?.signal.aborted) {
        console.error('[wechat-adapter] Poll loop crashed:', err instanceof Error ? err.message : err);
      }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// Self-register so bridge-manager can create WeChatAdapter via the registry.
registerAdapterFactory('wechat', () => new WeChatAdapter());
