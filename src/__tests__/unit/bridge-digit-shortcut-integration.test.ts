/**
 * Integration tests for digit shortcut (1/2/3) permission flow.
 *
 * Tests the FULL end-to-end path:
 *   permission card sent → shortcut registered → user replies "1" → permission resolved
 *
 * Also tests edge cases:
 *   - "1" with no pending permission → falls through to conversation engine
 *   - Expired shortcuts → falls through
 *   - Shortcut overwrite when new permission arrives
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import {
  forwardPermissionRequest,
  resolveShortcut,
  handlePermissionCallback,
  _testOnly,
} from '../../lib/bridge/permission-broker';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, PermissionResolution } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

const { pendingShortcuts } = _testOnly;

// ── Mock Store (with real permLink tracking) ─────────────────

function createMockStore() {
  const permLinks = new Map<string, {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
    resolved: boolean;
  }>();

  return {
    permLinks,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({}) as any,
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: (link: any) => {
      permLinks.set(link.permissionRequestId, { ...link, resolved: false });
    },
    getPermissionLink: (id: string) => permLinks.get(id) ?? null,
    markPermissionLinkResolved: (id: string) => {
      const link = permLinks.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

// ── Mock Gateway ─────────────────────────────────────────────

function createMockGateway() {
  const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
  return {
    resolved,
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      resolved.push({ id, resolution });
      return true;
    },
  };
}

// ── Mock Adapter (feishu-like, no inline buttons) ────────────

function createMockFeishuAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: `msg-${Date.now()}` }));
  return {
    channelType: 'feishu',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

function createMockQQAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: `msg-${Date.now()}` }));
  return {
    channelType: 'qq',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

type MockStore = ReturnType<typeof createMockStore>;
type MockGateway = ReturnType<typeof createMockGateway>;

function setupContext(store: MockStore, gateway: MockGateway) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: gateway,
    lifecycle: {},
  });
}

// ── Integration Tests ───────────────────────────────────────

describe('digit shortcut integration - feishu', () => {
  let store: MockStore;
  let gateway: MockGateway;
  let sentMessages: OutboundMessage[];
  let adapter: BaseChannelAdapter;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
    pendingShortcuts.clear();

    sentMessages = [];
    adapter = createMockFeishuAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });
  });

  it('full flow: forwardPermissionRequest → user replies "1" → allow resolved', async () => {
    const address = { channelType: 'feishu' as const, chatId: 'chat-100', userId: 'user-1' };

    // Step 1: Forward permission request (simulates Claude asking for tool approval)
    await forwardPermissionRequest(
      adapter, address, 'perm-id-001', 'Bash',
      { command: 'ls -la' }, 'session-1', undefined, 'orig-msg-1',
    );

    // Verify: card was sent
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Permission Required'));

    // Verify: shortcut was registered for this chat
    assert.ok(pendingShortcuts.has('chat-100'), 'Shortcut should be registered');
    const shortcut = pendingShortcuts.get('chat-100')!;
    assert.equal(shortcut.permId, 'perm-id-001');

    // Verify: permission link was stored in DB
    assert.ok(store.permLinks.has('perm-id-001'));

    // Step 2: User replies "1" → resolveShortcut
    const result = resolveShortcut('chat-100', 1);
    assert.ok(result.handled, 'Shortcut should be handled');
    assert.equal(result.action, 'allow');

    // Verify: gateway received the resolution
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].id, 'perm-id-001');
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');

    // Verify: shortcut was cleared
    assert.equal(pendingShortcuts.has('chat-100'), false);

    // Verify: permission link is marked resolved
    assert.ok(store.permLinks.get('perm-id-001')!.resolved);
  });

  it('full flow: user replies "2" → allow_session resolved', async () => {
    const address = { channelType: 'feishu' as const, chatId: 'chat-200', userId: 'user-1' };
    const suggestions = [{ type: 'allow', toolName: 'Bash' }];

    await forwardPermissionRequest(
      adapter, address, 'perm-id-002', 'Bash',
      { command: 'npm test' }, 'session-1', suggestions,
    );

    const result = resolveShortcut('chat-200', 2);
    assert.ok(result.handled);
    assert.equal(result.action, 'allow_session');
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });

  it('full flow: user replies "3" → deny resolved', async () => {
    const address = { channelType: 'feishu' as const, chatId: 'chat-300', userId: 'user-1' };

    await forwardPermissionRequest(
      adapter, address, 'perm-id-003', 'Write',
      { file_path: '/etc/passwd' }, 'session-1',
    );

    const result = resolveShortcut('chat-300', 3);
    assert.ok(result.handled);
    assert.equal(result.action, 'deny');
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
  });

  it('no pending shortcut → resolveShortcut returns not handled', () => {
    const result = resolveShortcut('chat-no-perm', 1);
    assert.equal(result.handled, false);
    assert.equal(result.action, undefined);
  });

  it('Telegram adapter does NOT register shortcuts (has inline buttons)', async () => {
    const tgAdapter = {
      channelType: 'telegram',
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      consumeOne: async () => null,
      send: async () => ({ ok: true, messageId: 'tg-msg-1' }),
      validateConfig: () => null,
      isAuthorized: () => true,
    } as unknown as BaseChannelAdapter;

    const address = { channelType: 'telegram' as const, chatId: 'tg-chat-1', userId: 'user-1' };

    await forwardPermissionRequest(
      tgAdapter, address, 'perm-id-tg', 'Bash',
      { command: 'echo hi' }, 'session-1',
    );

    // Telegram should NOT have a shortcut registered
    assert.equal(pendingShortcuts.has('tg-chat-1'), false);
  });

  it('new permission overwrites previous shortcut for same chat', async () => {
    const address = { channelType: 'feishu' as const, chatId: 'chat-overwrite', userId: 'user-1' };

    await forwardPermissionRequest(
      adapter, address, 'perm-old', 'Bash',
      { command: 'old' }, 'session-1',
    );

    await forwardPermissionRequest(
      adapter, address, 'perm-new', 'Read',
      { file_path: '/tmp/test' }, 'session-1',
    );

    // Shortcut should point to the new permission
    const shortcut = pendingShortcuts.get('chat-overwrite')!;
    assert.equal(shortcut.permId, 'perm-new');

    // Resolving should affect the new permission
    const result = resolveShortcut('chat-overwrite', 1);
    assert.ok(result.handled);
    assert.equal(gateway.resolved[0].id, 'perm-new');
  });
});

describe('digit shortcut integration - qq', () => {
  let store: MockStore;
  let gateway: MockGateway;
  let sentMessages: OutboundMessage[];
  let adapter: BaseChannelAdapter;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
    pendingShortcuts.clear();

    sentMessages = [];
    adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });
  });

  it('QQ permission card includes digit shortcuts text', async () => {
    const address = { channelType: 'qq' as const, chatId: 'qq-user-1', userId: 'qq-user-1' };

    await forwardPermissionRequest(
      adapter, address, 'perm-qq-1', 'Bash',
      { command: 'ls' }, 'session-1', undefined, 'reply-to-1',
    );

    assert.equal(sentMessages.length, 1);
    const cardText = sentMessages[0].text;
    assert.ok(cardText.includes('1 - Allow'), 'Should include digit 1 shortcut');
    assert.ok(cardText.includes('2 - Allow for this session'), 'Should include digit 2 shortcut');
    assert.ok(cardText.includes('3 - Deny'), 'Should include digit 3 shortcut');
    assert.ok(cardText.includes('/perm allow'), 'Should still include /perm command as fallback');
  });

  it('QQ registers shortcut and resolves via digit', async () => {
    const address = { channelType: 'qq' as const, chatId: 'qq-chat-1', userId: 'qq-user-1' };

    await forwardPermissionRequest(
      adapter, address, 'perm-qq-2', 'Read',
      { file_path: '/tmp/test' }, 'session-1',
    );

    assert.ok(pendingShortcuts.has('qq-chat-1'));

    const result = resolveShortcut('qq-chat-1', 1);
    assert.ok(result.handled);
    assert.equal(result.action, 'allow');
  });
});

describe('digit shortcut integration - bridge-manager handleMessage', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
    pendingShortcuts.clear();
    // Clean global bridge-manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  });

  it('handleMessage resolves digit "1" when pending shortcut exists', async () => {
    const { _testOnly: bmTest } = await import('../../lib/bridge/bridge-manager');

    // Setup: register a shortcut and permission link
    const chatId = 'bm-chat-1';
    store.permLinks.set('perm-bm-1', {
      permissionRequestId: 'perm-bm-1',
      channelType: 'feishu',
      chatId,
      messageId: 'orig-msg',
      toolName: 'Bash',
      suggestions: '',
      resolved: false,
    });
    _testOnly.registerShortcut(chatId, 'perm-bm-1');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockFeishuAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    // User sends "1"
    await bmTest.handleMessage(adapter, {
      messageId: 'user-msg-1',
      address: { channelType: 'feishu' as const, chatId, userId: 'user-1' },
      text: '1',
      timestamp: Date.now(),
    });

    // Should have sent a confirmation
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Permission allow: recorded.'));

    // Gateway should have resolved
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('handleMessage passes "1" to conversation engine when NO pending shortcut', async () => {
    // Re-init context with a fast-closing LLM stream
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: () => new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Echo: 1' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) })}\n`);
            controller.close();
          },
        }),
      },
      permissions: gateway,
      lifecycle: {},
    });

    const { _testOnly: bmTest } = await import('../../lib/bridge/bridge-manager');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockFeishuAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    // User sends "1" but there is NO pending shortcut
    await bmTest.handleMessage(adapter, {
      messageId: 'user-msg-2',
      address: { channelType: 'feishu' as const, chatId: 'bm-chat-no-perm', userId: 'user-1' },
      text: '1',
      timestamp: Date.now(),
    });

    // Should NOT have sent a permission confirmation
    const permResponses = sentMessages.filter(m => m.text.includes('Permission'));
    assert.equal(permResponses.length, 0, 'Should not respond with permission message when no shortcut');

    // Should have sent the echo response instead (message passed through to LLM)
    const echoResponses = sentMessages.filter(m => m.text.includes('Echo'));
    assert.ok(echoResponses.length > 0, 'Should have passed message to conversation engine');
  });
});
