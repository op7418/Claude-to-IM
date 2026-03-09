/**
 * Unit tests for bridge permission-broker.
 *
 * Tests cover:
 * - handlePermissionCallback: action parsing, chat validation, dedup
 * - Permission resolution via PermissionGateway
 * - Callback data parsing with colons in permId
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { handlePermissionCallback, resolveShortcut, _testOnly } from '../../lib/bridge/permission-broker';
import type { BridgeStore, PermissionGateway, PermissionResolution } from '../../lib/bridge/host';

const { registerShortcut, clearShortcut, pendingShortcuts } = _testOnly;

// ── Mock Store ──────────────────────────────────────────────

function createMockStore() {
  const links = new Map<string, { chatId: string; messageId: string; resolved: boolean; suggestions: string }>();

  return {
    links,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
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
    insertPermissionLink: () => {},
    getPermissionLink: (id: string) => {
      return links.get(id) ?? null;
    },
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

// ── Mock Permission Gateway ─────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────

describe('permission-broker', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('returns false for non-perm callback data', () => {
    assert.equal(handlePermissionCallback('other:data', '123'), false);
  });

  it('returns false when permission link not found', () => {
    assert.equal(handlePermissionCallback('perm:allow:unknown-id', '123'), false);
  });

  it('returns false when chatId does not match', () => {
    store.links.set('perm-1', {
      chatId: '999',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123'), false);
  });

  it('returns false when messageId does not match', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123', 'wrong-msg'), false);
  });

  it('resolves allow action correctly', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123');
    assert.ok(result);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolves deny action correctly', () => {
    store.links.set('perm-2', {
      chatId: '456',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:deny:perm-2', '456');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.equal(gateway.resolved[0].resolution.message, 'Denied via IM bridge');
  });

  it('prevents duplicate resolution', () => {
    store.links.set('perm-3', {
      chatId: '123',
      messageId: 'msg-3',
      resolved: false,
      suggestions: '',
    });

    const first = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.ok(first);

    const second = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(second, false);
    assert.equal(gateway.resolved.length, 1);
  });

  it('handles permId with colons', () => {
    store.links.set('perm:with:colons', {
      chatId: '123',
      messageId: 'msg-4',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm:with:colons', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].id, 'perm:with:colons');
  });

  it('allow_session passes suggestions as updatedPermissions', () => {
    const suggestions = JSON.stringify([{ type: 'allow', toolName: 'Bash' }]);
    store.links.set('perm-4', {
      chatId: '123',
      messageId: 'msg-5',
      resolved: false,
      suggestions,
    });

    const result = handlePermissionCallback('perm:allow_session:perm-4', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });
});

// ── Digit Shortcut Tests ──────────────────────────────────────

describe('permission-broker digit shortcuts', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
    // Clear any leftover shortcuts from previous tests
    pendingShortcuts.clear();
  });

  it('resolveShortcut returns not handled when no shortcut registered', () => {
    const result = resolveShortcut('chat-1', 1);
    assert.equal(result.handled, false);
  });

  it('resolveShortcut resolves digit 1 to allow', () => {
    // Register a shortcut and matching permission link
    store.links.set('perm-s1', {
      chatId: 'chat-1',
      messageId: 'msg-s1',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-1', 'perm-s1');

    const result = resolveShortcut('chat-1', 1);
    assert.ok(result.handled);
    assert.equal(result.action, 'allow');
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolveShortcut resolves digit 2 to allow_session', () => {
    store.links.set('perm-s2', {
      chatId: 'chat-2',
      messageId: 'msg-s2',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-2', 'perm-s2');

    const result = resolveShortcut('chat-2', 2);
    assert.ok(result.handled);
    assert.equal(result.action, 'allow_session');
  });

  it('resolveShortcut resolves digit 3 to deny', () => {
    store.links.set('perm-s3', {
      chatId: 'chat-3',
      messageId: 'msg-s3',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-3', 'perm-s3');

    const result = resolveShortcut('chat-3', 3);
    assert.ok(result.handled);
    assert.equal(result.action, 'deny');
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
  });

  it('resolveShortcut clears shortcut after successful resolution', () => {
    store.links.set('perm-s4', {
      chatId: 'chat-4',
      messageId: 'msg-s4',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-4', 'perm-s4');

    resolveShortcut('chat-4', 1);
    // Shortcut should be cleared
    assert.equal(pendingShortcuts.has('chat-4'), false);
  });

  it('resolveShortcut returns not handled for expired shortcuts', () => {
    store.links.set('perm-s5', {
      chatId: 'chat-5',
      messageId: 'msg-s5',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-5', 'perm-s5');

    // Manually expire the shortcut
    const shortcut = pendingShortcuts.get('chat-5')!;
    shortcut.expireAt = Date.now() - 1;

    const result = resolveShortcut('chat-5', 1);
    assert.equal(result.handled, false);
  });

  it('new shortcut overwrites old one for same chat', () => {
    store.links.set('perm-old', {
      chatId: 'chat-6',
      messageId: 'msg-old',
      resolved: false,
      suggestions: '',
    });
    store.links.set('perm-new', {
      chatId: 'chat-6',
      messageId: 'msg-new',
      resolved: false,
      suggestions: '',
    });

    registerShortcut('chat-6', 'perm-old');
    registerShortcut('chat-6', 'perm-new');

    const result = resolveShortcut('chat-6', 1);
    assert.ok(result.handled);
    // Should resolve the new permission, not the old one
    assert.equal(gateway.resolved[0].id, 'perm-new');
  });

  it('resolveShortcut returns not handled for invalid digit', () => {
    store.links.set('perm-s7', {
      chatId: 'chat-7',
      messageId: 'msg-s7',
      resolved: false,
      suggestions: '',
    });
    registerShortcut('chat-7', 'perm-s7');

    const result = resolveShortcut('chat-7', 4);
    assert.equal(result.handled, false);
  });
});
