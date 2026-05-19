import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as router from '../../lib/bridge/channel-router';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

type TestStore = BridgeStore & {
  bindings: Map<string, ChannelBinding>;
  sessions: Map<string, BridgeSession>;
};

function bindingKey(channelType: string, chatId: string, botName?: string): string {
  return botName ? `${channelType}:${botName}:${chatId}` : `${channelType}:${chatId}`;
}

function createStore(defaultCwd = '/tmp/default'): TestStore {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, BridgeSession>();
  let nextId = 1;

  return {
    bindings,
    sessions,
    getSetting(key: string) {
      if (key === 'bridge_default_work_dir') return defaultCwd;
      if (key === 'bridge_default_model') return 'gpt-test';
      if (key === 'bridge_default_provider_id') return '';
      return null;
    },
    getChannelBinding(channelType: string, chatId: string, botName?: string) {
      return bindings.get(bindingKey(channelType, chatId, botName)) ?? null;
    },
    upsertChannelBinding(data) {
      const key = bindingKey(data.channelType, data.chatId, data.botName);
      const binding: ChannelBinding = {
        id: bindings.get(key)?.id ?? `binding-${nextId++}`,
        channelType: data.channelType,
        botName: data.botName,
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId ?? '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: (data.mode as ChannelBinding['mode']) ?? 'code',
        active: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
      for (const [key, binding] of bindings) {
        if (binding.id === id) {
          bindings.set(key, { ...binding, ...updates });
          return;
        }
      }
    },
    listChannelBindings(channelType?: string) {
      const all = Array.from(bindings.values());
      return channelType ? all.filter(binding => binding.channelType === channelType) : all;
    },
    getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    createSession(name: string, model: string, systemPrompt?: string, cwd?: string, mode?: string) {
      void name;
      void systemPrompt;
      void mode;
      const session = { id: `session-${nextId++}`, working_directory: cwd ?? '', model };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId() {},
    addMessage() {},
    getMessages() { return { messages: [] }; },
    acquireSessionLock() { return true; },
    renewSessionLock() {},
    releaseSessionLock() {},
    setSessionRuntimeStatus() {},
    updateSdkSessionId() {},
    updateSessionModel() {},
    syncSdkTasks() {},
    getProvider() { return undefined; },
    getDefaultProviderId() { return null; },
    insertAuditLog() {},
    checkDedup() { return false; },
    insertDedup() {},
    cleanupExpiredDedup() {},
    insertOutboundRef() {},
    insertPermissionLink() {},
    getPermissionLink() { return null; },
    markPermissionLinkResolved() { return false; },
    listPendingPermissionLinksByChat() { return []; },
    getChannelOffset() { return '0'; },
    setChannelOffset() {},
  };
}

describe('channel-router store parameter', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('resolve() uses the injected store without bridge context', () => {
    const store = createStore('/tmp/injected');

    const binding = router.resolve(
      { channelType: 'feishu', botName: 'bot-a', chatId: 'oc_1', displayName: 'Bot A Chat' },
      { store },
    );

    assert.equal(binding.botName, 'bot-a');
    assert.equal(binding.workingDirectory, '/tmp/injected');
    assert.equal(store.bindings.size, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('resolve() includes botName when reading existing bindings', () => {
    const store = createStore();
    const botABinding = router.createBinding(
      { channelType: 'feishu', botName: 'bot-a', chatId: 'oc_same' },
      { store, workingDirectory: '/tmp/a' },
    );
    const botBBinding = router.createBinding(
      { channelType: 'feishu', botName: 'bot-b', chatId: 'oc_same' },
      { store, workingDirectory: '/tmp/b' },
    );

    const resolvedA = router.resolve(
      { channelType: 'feishu', botName: 'bot-a', chatId: 'oc_same' },
      { store },
    );
    const resolvedB = router.resolve(
      { channelType: 'feishu', botName: 'bot-b', chatId: 'oc_same' },
      { store },
    );

    assert.equal(resolvedA.id, botABinding.id);
    assert.equal(resolvedB.id, botBBinding.id);
    assert.notEqual(resolvedA.codepilotSessionId, resolvedB.codepilotSessionId);
  });

  it('createBinding() uses workingDirectory from RouterOpts', () => {
    const store = createStore('/tmp/default');

    const binding = router.createBinding(
      { channelType: 'feishu', botName: 'bot-c', chatId: 'oc_2' },
      { store, workingDirectory: '/tmp/from-opts' },
    );

    assert.equal(binding.botName, 'bot-c');
    assert.equal(binding.workingDirectory, '/tmp/from-opts');
    assert.equal(store.sessions.get(binding.codepilotSessionId)?.working_directory, '/tmp/from-opts');
  });
});
