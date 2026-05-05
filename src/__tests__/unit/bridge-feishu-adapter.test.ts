import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { FeishuBotConfig } from '../../lib/bridge/types';

function createMockStore(settings: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: 'session-1', working_directory: '', model: '' }),
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

function setupContext(store: BridgeStore): void {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function createConfig(overrides: Partial<FeishuBotConfig> = {}): FeishuBotConfig {
  return {
    name: 'ccbot',
    appId: 'cli_test',
    appSecret: 'secret_test',
    ...overrides,
  };
}

describe('FeishuAdapter multi-instance config', () => {
  let store: BridgeStore;

  beforeEach(() => {
    store = createMockStore({ bridge_default_work_dir: '/global/default' }) as unknown as BridgeStore;
    setupContext(store);
  });

  test('instanceKey includes bot name and exposes botStore', () => {
    const adapter = new FeishuAdapter(createConfig({ name: 'jason' }), store);

    assert.equal(adapter.instanceKey, 'feishu:jason');
    assert.equal(adapter.botStore, store);
  });

  test('resolveWorkingDirectory prefers user override before bot and global defaults', () => {
    const adapter = new FeishuAdapter(createConfig({
      workingDirectory: '/bot/default',
      userOverrides: new Map([
        ['ou_1', { workingDirectory: '/users/ou_1' }],
      ]),
    }), store);

    assert.equal(adapter.resolveWorkingDirectory('ou_1'), '/users/ou_1');
    assert.equal(adapter.resolveWorkingDirectory('ou_2'), '/bot/default');
  });

  test('resolveWorkingDirectory falls back to global default when bot has no working directory', () => {
    const adapter = new FeishuAdapter(createConfig(), store);

    assert.equal(adapter.resolveWorkingDirectory('ou_1'), '/global/default');
  });
});
