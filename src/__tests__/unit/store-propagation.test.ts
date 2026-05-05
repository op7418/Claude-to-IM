/**
 * Unit tests for explicit BridgeStore propagation across engine -> broker -> delivery.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import { forwardPermissionRequest } from '../../lib/bridge/permission-broker';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, LLMProvider, PermissionGateway } from '../../lib/bridge/host';
import type { ChannelAddress, OutboundMessage, SendResult } from '../../lib/bridge/types';

function streamFromEvents(events: Array<{ type: string; data: unknown }>): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(`data: ${JSON.stringify({
          type: event.type,
          data: typeof event.data === 'string' ? event.data : JSON.stringify(event.data),
        })}\n`);
      }
      controller.close();
    },
  });
}

function createMockStore(name: string) {
  const messages: Array<{ sessionId: string; role: string; content: string }> = [];
  const auditLogs: unknown[] = [];
  const outboundRefs: unknown[] = [];
  const permissionLinks: unknown[] = [];
  const dedupKeys = new Set<string>();

  return {
    name,
    messages,
    auditLogs,
    outboundRefs,
    permissionLinks,
    dedupKeys,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: (id: string) => ({ id, working_directory: '', model: '' }),
    createSession: () => ({ id: 'session-created', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: (sessionId: string, role: string, content: string) => {
      messages.push({ sessionId, role, content });
    },
    getMessages: () => ({ messages: messages.map(m => ({ role: m.role, content: m.content })) }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: (entry: unknown) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
    cleanupExpiredDedup: () => {},
    insertOutboundRef: (ref: unknown) => { outboundRefs.push(ref); },
    insertPermissionLink: (link: unknown) => { permissionLinks.push(link); },
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createMockAdapter(): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (_msg: OutboundMessage): Promise<SendResult> => ({ ok: true, messageId: 'platform-msg-1' }),
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

describe('store propagation', () => {
  let globalStore: ReturnType<typeof createMockStore>;
  let injectedStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    globalStore = createMockStore('global');
    injectedStore = createMockStore('injected');

    const llm: LLMProvider = {
      streamChat: () => streamFromEvents([
        {
          type: 'permission_request',
          data: {
            permissionRequestId: 'perm-store-flow',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            suggestions: [{ type: 'allow', toolName: 'Bash' }],
          },
        },
        { type: 'text', data: 'done' },
      ]),
    };

    const permissions: PermissionGateway = {
      resolvePendingPermission: () => false,
    };

    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({
      store: globalStore as unknown as BridgeStore,
      llm,
      permissions,
      lifecycle: {},
    });
  });

  it('passes processMessage opts.store through permission broker delivery', async () => {
    const adapter = createMockAdapter();
    const address: ChannelAddress = { channelType: 'telegram', chatId: 'chat-1' };
    const permissionForwards: Promise<void>[] = [];
    let callbackStore: BridgeStore | undefined;

    const result = await processMessage(
      {
        id: 'binding-1',
        channelType: 'telegram',
        chatId: 'chat-1',
        codepilotSessionId: 'session-1',
        workingDirectory: '',
        model: '',
        mode: 'code',
      } as any,
      'hello',
      (perm, opts) => {
        callbackStore = opts?.store;
        const forward = forwardPermissionRequest(
          adapter,
          address,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          'session-1',
          perm.suggestions,
          undefined,
          opts?.store,
        );
        permissionForwards.push(forward);
        return forward;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { store: injectedStore as unknown as BridgeStore },
    );

    await Promise.all(permissionForwards);

    assert.equal(result.responseText, 'done');
    assert.equal(callbackStore, injectedStore);
    assert.equal(injectedStore.permissionLinks.length, 1);
    assert.equal(injectedStore.outboundRefs.length, 1);
    assert.equal(injectedStore.auditLogs.length, 1);
    assert.equal(globalStore.permissionLinks.length, 0);
    assert.equal(globalStore.outboundRefs.length, 0);
    assert.equal(globalStore.auditLogs.length, 0);
  });
});
