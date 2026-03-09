/**
 * Permission Broker — forwards Claude permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When Claude needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

/**
 * Per-chat pending permission shortcut mapping.
 * When a permission card is sent, we register a shortcut so users can
 * reply with 1/2/3 instead of typing the full /perm command.
 * Each chat keeps only the latest pending permission (new overwrites old).
 */
interface PendingShortcut {
  permId: string;
  actions: readonly ['allow', 'allow_session', 'deny'];
  expireAt: number;
}

const SHORTCUT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingShortcuts = new Map<string, PendingShortcut>();

/**
 * Register a digit shortcut mapping for a chat after sending a permission card.
 */
function registerShortcut(chatId: string, permId: string): void {
  pendingShortcuts.set(chatId, {
    permId,
    actions: ['allow', 'allow_session', 'deny'],
    expireAt: Date.now() + SHORTCUT_TTL_MS,
  });
}

/**
 * Clear the pending shortcut for a chat (called after resolution).
 */
function clearShortcut(chatId: string): void {
  pendingShortcuts.delete(chatId);
}

/**
 * Resolve a digit shortcut (1/2/3) for a given chat.
 * Returns the result of handlePermissionCallback if a mapping exists.
 */
export function resolveShortcut(
  chatId: string,
  digit: number,
): { handled: boolean; action?: string } {
  const shortcut = pendingShortcuts.get(chatId);
  if (!shortcut) return { handled: false };

  // Check expiry
  if (Date.now() > shortcut.expireAt) {
    pendingShortcuts.delete(chatId);
    return { handled: false };
  }

  // digit is 1-indexed, actions array is 0-indexed
  const action = shortcut.actions[digit - 1];
  if (!action) return { handled: false };

  const callbackData = `perm:${action}:${shortcut.permId}`;
  const resolved = handlePermissionCallback(callbackData, chatId);

  if (resolved) {
    clearShortcut(chatId);
    return { handled: true, action };
  }

  return { handled: false };
}

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  // Format the input summary (truncated)
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  let result: import('./types.js').SendResult;

  if (adapter.channelType === 'qq') {
    // QQ: plain text permission prompt with digit shortcuts (no inline buttons)
    const qqText = [
      `Permission Required`,
      ``,
      `Tool: ${toolName}`,
      truncatedInput,
      ``,
      `Reply with:`,
      `1 - Allow`,
      `2 - Allow for this session`,
      `3 - Deny`,
      ``,
      `Or use commands:`,
      `/perm allow ${permissionRequestId}`,
      `/perm allow_session ${permissionRequestId}`,
      `/perm deny ${permissionRequestId}`,
    ].join('\n');

    const qqMessage: OutboundMessage = {
      address,
      text: qqText,
      parseMode: 'plain',
      replyToMessageId,
    };

    result = await deliver(adapter, qqMessage, { sessionId });
  } else {
    const text = [
      `<b>Permission Required</b>`,
      ``,
      `Tool: <code>${escapeHtml(toolName)}</code>`,
      `<pre>${escapeHtml(truncatedInput)}</pre>`,
      ``,
      `Choose an action:`,
    ].join('\n');

    const message: OutboundMessage = {
      address,
      text,
      parseMode: 'HTML',
      inlineButtons: [
        [
          { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
          { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
          { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
        ],
      ],
      replyToMessageId,
    };

    result = await deliver(adapter, message, { sessionId });
  }

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }

    // Register digit shortcut for non-Telegram channels (Telegram has inline buttons)
    if (adapter.channelType !== 'telegram') {
      registerShortcut(address.chatId, permissionRequestId);
    }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  const { store, permissions } = getBridgeContext();

  // Parse callback data: perm:action:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
      });
      break;

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
      break;
    }

    case 'deny':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    default:
      return false;
  }

  return resolved;
}

// ── Test-only exports ────────────────────────────────────────
/** @internal */
export const _testOnly = { registerShortcut, clearShortcut, pendingShortcuts };
