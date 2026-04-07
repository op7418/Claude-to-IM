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
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';

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

  it('returns an explicit busy reply instead of silently queueing same-session follow-ups', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: string[] = [];
    const adapter = {
      channelType: 'weixin',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'busy-msg' };
      },
      acknowledgeUpdate: () => {},
    } as any;

    const { _testOnly, getStatus } = await import('../../lib/bridge/bridge-manager');
    getStatus();
    const state = (globalThis as Record<string, any>)['__bridge_manager__'];
    state.activeTasks.set('session-1', {
      abortController: new AbortController(),
      startedAt: Date.now() - 30_000,
      lastActivityAt: Date.now() - 5_000,
    });

    const handled = await _testOnly.maybeHandleBusySession(adapter, {
      messageId: 'm-1',
      address: { channelType: 'weixin', chatId: 'chat-1', userId: 'u-1' },
      text: 'still there?',
      timestamp: Date.now(),
    }, 'session-1');

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Current task is still running/);
    assert.match(sent[0], /\/stop/);
  });

  it('aborts stale active tasks so the next message can proceed', async () => {
    const oldStale = process.env.CTI_ACTIVE_TASK_STALE_MS;
    process.env.CTI_ACTIVE_TASK_STALE_MS = '1000';

    try {
      const store = createMinimalStore({ remote_bridge_enabled: 'false' });
      initBridgeContext({
        store,
        llm: { streamChat: () => new ReadableStream() },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const sent: string[] = [];
      const adapter = {
        channelType: 'weixin',
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: 'stale-msg' };
        },
        acknowledgeUpdate: () => {},
      } as any;

      const { _testOnly, getStatus } = await import('../../lib/bridge/bridge-manager');
      getStatus();
      const state = (globalThis as Record<string, any>)['__bridge_manager__'];
      const abortController = new AbortController();
      state.activeTasks.set('session-2', {
        abortController,
        startedAt: Date.now() - 120_000,
        lastActivityAt: Date.now() - 90_000,
      });

      const handled = await _testOnly.maybeHandleBusySession(adapter, {
        messageId: 'm-2',
        address: { channelType: 'weixin', chatId: 'chat-2', userId: 'u-2' },
        text: 'retry this',
        timestamp: Date.now(),
      }, 'session-2');

      assert.equal(handled, false);
      assert.equal(abortController.signal.aborted, true);
      assert.equal(state.activeTasks.has('session-2'), false);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /looked stuck/);
    } finally {
      if (oldStale === undefined) delete process.env.CTI_ACTIVE_TASK_STALE_MS;
      else process.env.CTI_ACTIVE_TASK_STALE_MS = oldStale;
    }
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
