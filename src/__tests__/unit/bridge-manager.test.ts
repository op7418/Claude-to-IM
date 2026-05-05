/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  it('registers and looks up adapters by instanceKey', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { registerAdapter, getAdapter, getStatus } = await import('../../lib/bridge/bridge-manager');
    const adapter = createMockAdapter({ channelType: 'feishu', instanceKey: 'feishu:ccbot' });

    registerAdapter(adapter);

    assert.equal(getAdapter('feishu:ccbot'), adapter);
    assert.equal(getAdapter('feishu'), undefined);
    assert.equal(getStatus().adapters[0].instanceKey, 'feishu:ccbot');
  });

  it('derives the store from adapter.botStore for commands and permission callbacks', async () => {
    const globalStore = createTrackingStore('global');
    const botStore = createTrackingStore('ccbot');
    initBridgeContext({
      store: globalStore as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createMockAdapter({
      channelType: 'feishu',
      instanceKey: 'feishu:ccbot',
      botStore: botStore as unknown as BridgeStore,
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-new',
      address: { channelType: 'feishu', botName: 'ccbot', chatId: 'chat-1' },
      text: '/new /tmp',
      timestamp: Date.now(),
    });

    assert.ok(botStore.createdSessions.length > 0);
    assert.equal(globalStore.createdSessions.length, 0);

    botStore.permissionLink = {
      permissionRequestId: 'perm-1',
      chatId: 'chat-1',
      messageId: 'perm-msg-1',
      resolved: false,
    };

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-callback',
      address: { channelType: 'feishu', botName: 'ccbot', chatId: 'chat-1' },
      text: '',
      callbackData: 'perm:allow:perm-1',
      callbackMessageId: 'perm-msg-1',
      timestamp: Date.now(),
    });

    assert.deepEqual(botStore.resolvedPermissionIds, ['perm-1']);
    assert.deepEqual(globalStore.resolvedPermissionIds, []);
    assert.equal(adapter.sentMessages.length, 2);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
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
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createTrackingStore(name: string) {
  const createdSessions: string[] = [];
  const resolvedPermissionIds: string[] = [];
  let permissionLink: any = null;

  return {
    name,
    createdSessions,
    resolvedPermissionIds,
    get permissionLink() { return permissionLink; },
    set permissionLink(value: any) { permissionLink = value; },
    getSetting: (key: string) => key === 'bridge_default_work_dir' ? '/default' : null,
    getChannelBinding: () => null,
    upsertChannelBinding: (binding: any) => ({
      id: `${name}-binding`,
      active: true,
      createdAt: '',
      updatedAt: '',
      ...binding,
    }),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => {
      const id = `${name}-session-${createdSessions.length + 1}`;
      createdSessions.push(id);
      return { id, working_directory: '/tmp', model: '' };
    },
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
    getPermissionLink: (permissionRequestId: string) =>
      permissionLink?.permissionRequestId === permissionRequestId ? permissionLink : null,
    markPermissionLinkResolved: (permissionRequestId: string) => {
      if (!permissionLink || permissionLink.permissionRequestId !== permissionRequestId) return false;
      resolvedPermissionIds.push(permissionRequestId);
      permissionLink.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createMockAdapter(opts: {
  channelType: string;
  instanceKey: string;
  botStore?: BridgeStore;
}): BaseChannelAdapter & { sentMessages: OutboundMessage[]; botStore?: BridgeStore } {
  const sentMessages: OutboundMessage[] = [];
  return {
    channelType: opts.channelType,
    get instanceKey() { return opts.instanceKey; },
    botStore: opts.botStore,
    sentMessages,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async (): Promise<InboundMessage | null> => null,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sentMessages.push(message);
      return { ok: true, messageId: `sent-${sentMessages.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter & { sentMessages: OutboundMessage[]; botStore?: BridgeStore };
}
