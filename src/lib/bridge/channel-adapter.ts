/**
 * Abstract base class for IM channel adapters.
 *
 * Each adapter (Telegram, Discord, Slack, ...) extends this class to provide
 * platform-specific message consumption and delivery.
 */

import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from './types.js';

export abstract class BaseChannelAdapter {
  /** Which channel type this adapter handles */
  abstract readonly channelType: ChannelType;

  /**
   * Start the adapter (connect, begin polling/websocket, etc.).
   * Must be idempotent — calling start() on an already-running adapter is a no-op.
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter gracefully.
   * Must be idempotent — calling stop() on an already-stopped adapter is a no-op.
   */
  abstract stop(): Promise<void>;

  /** Whether the adapter is currently running and consuming messages */
  abstract isRunning(): boolean;

  /**
   * Consume the next inbound message from the internal queue.
   * Blocks until a message is available or the adapter is stopped.
   * Returns null if the adapter was stopped while waiting.
   */
  abstract consumeOne(): Promise<InboundMessage | null>;

  /**
   * Send an outbound message to the channel.
   * Handles platform-specific formatting and API calls.
   */
  abstract send(message: OutboundMessage): Promise<SendResult>;

  /**
   * Answer a callback query (e.g. Telegram inline button press).
   * Not all platforms support this — default implementation is a no-op.
   */
  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op by default; override in adapters that support callback queries
  }

  /**
   * Validate that the adapter's configuration is complete.
   * Returns null if valid, or an error message string if invalid.
   */
  abstract validateConfig(): string | null;

  /**
   * Check whether a user is authorized to use this bridge.
   * Returns true if authorized, false otherwise.
   */
  abstract isAuthorized(userId: string, chatId: string): boolean;

  /** Called when message processing starts (e.g., typing indicator). */
  onMessageStart?(_chatId: string): void;

  /** Called when message processing ends. */
  onMessageEnd?(_chatId: string): void;

  /**
   * Acknowledge that an update has been fully processed.
   * Adapters that defer offset commits until after handleMessage should implement this.
   * Default is a no-op; override in adapters that need deferred offset tracking.
   */
  acknowledgeUpdate?(_updateId: number): void;

  /**
   * Return preview capabilities for a given chat.
   * Returning null means streaming preview is not available for this chat.
   */
  getPreviewCapabilities?(_chatId: string): PreviewCapabilities | null;

  /**
   * Send (or update) a streaming preview draft.
   * Returns 'sent' on success, 'skip' for transient failures (caller should
   * retry later), or 'degrade' for permanent failures (caller should stop).
   */
  sendPreview?(_chatId: string, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * Signal the end of a preview cycle. The final message is sent via the
   * normal delivery path, so this is typically a no-op.
   */
  endPreview?(_chatId: string, _draftId: number): void;

  /**
   * Called on each text SSE event during streaming. Adapter can use this
   * to update a streaming card in real-time. Only called for adapters
   * that support streaming cards (e.g. Feishu CardKit v2).
   */
  onStreamText?(_chatId: string, _fullText: string): void;

  /**
   * Called when tool_use / tool_result events arrive during streaming.
   * Adapter can use this to display tool progress in the streaming card.
   */
  onToolEvent?(_chatId: string, _tools: import('./types.js').ToolCallInfo[]): void;

  /**
   * Called when streaming ends. Adapter should finalize the streaming card
   * (close streaming mode, add footer, etc.).
   * Returns true if a card was finalized (caller should skip normal delivery).
   */
  onStreamEnd?(_chatId: string, _status: 'completed' | 'interrupted' | 'error', _responseText: string): Promise<boolean>;
}

// ── Adapter Registry ────────────────────────────────────────────

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
