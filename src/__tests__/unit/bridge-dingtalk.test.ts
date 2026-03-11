/**
 * Unit tests for DingTalk bridge support.
 *
 * Tests cover:
 * - PLATFORM_LIMITS for DingTalk
 * - DingTalkAdapter config validation / authorization
 * - DingTalkAdapter callback parsing and sessionWebhook send behavior
 * - Permission broker text fallback for DingTalk
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { PLATFORM_LIMITS } from '../../lib/bridge/types';
import { DingTalkAdapter } from '../../lib/bridge/adapters/dingtalk-adapter';
import { forwardPermissionRequest } from '../../lib/bridge/permission-broker';
import { EchoLLM, InteractivePermissionGateway } from '../../lib/bridge/examples/example-support';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

function createMockStore(settings: Record<string, string> = {}) {
  const permissionLinks: any[] = [];

  return {
    permissionLinks,
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
    insertPermissionLink: (link: any) => { permissionLinks.push(link); },
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

type MockStore = ReturnType<typeof createMockStore>;

function setupContext(store: MockStore) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function createMockDingtalkAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: 'msg-1' }));
  return {
    channelType: 'dingtalk',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

describe('types - dingtalk platform limit', () => {
  it('dingtalk limit is 20000', () => {
    assert.equal(PLATFORM_LIMITS.dingtalk, 20000);
  });
});

describe('dingtalk-adapter', () => {
  let store: MockStore;
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    store = createMockStore({
      bridge_dingtalk_enabled: 'true',
      bridge_dingtalk_client_id: 'client-id',
      bridge_dingtalk_client_secret: 'client-secret',
    });
    setupContext(store);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (globalThis as Record<string, unknown>).fetch;
    }
  });

  it('validates required config', () => {
    const adapter = new DingTalkAdapter();
    assert.equal(adapter.validateConfig(), null);

    setupContext(createMockStore({ bridge_dingtalk_enabled: 'true' }));
    assert.equal(new DingTalkAdapter().validateConfig(), 'bridge_dingtalk_client_id not configured');
  });

  it('authorizes by user or chat allowlist', () => {
    setupContext(createMockStore({
      bridge_dingtalk_enabled: 'true',
      bridge_dingtalk_client_id: 'client-id',
      bridge_dingtalk_client_secret: 'client-secret',
      bridge_dingtalk_allowed_users: 'user-a,chat-b',
    }));

    const adapter = new DingTalkAdapter();
    assert.equal(adapter.isAuthorized('user-a', 'chat-x'), true);
    assert.equal(adapter.isAuthorized('user-x', 'chat-b'), true);
    assert.equal(adapter.isAuthorized('user-x', 'chat-x'), false);
  });

  it('treats * as allow-all', () => {
    setupContext(createMockStore({
      bridge_dingtalk_enabled: 'true',
      bridge_dingtalk_client_id: 'client-id',
      bridge_dingtalk_client_secret: 'client-secret',
      bridge_dingtalk_allowed_users: '*',
    }));

    const adapter = new DingTalkAdapter();
    assert.equal(adapter.isAuthorized('any-user', 'any-chat'), true);
  });

  it('parses inbound callbacks, caches sessionWebhook, and acks immediately', async () => {
    const adapter = new DingTalkAdapter();
    const acked: Array<{ messageId: string; payload: unknown }> = [];

    (adapter as any).client = {
      socketCallBackResponse: (messageId: string, payload: unknown) => {
        acked.push({ messageId, payload });
      },
    };

    await (adapter as any).handleRobotCallback({
      headers: {
        appId: 'app',
        connectionId: 'conn',
        contentType: 'application/json',
        messageId: 'stream-msg-1',
        time: String(Date.now()),
        topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgId: 'robot-msg-1',
        conversationId: 'cid-1',
        conversationType: '1',
        senderStaffId: 'user-1',
        senderId: '$:sender',
        senderNick: 'Alice',
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 60_000,
        createAt: Date.now(),
        msgtype: 'text',
        text: { content: 'hello dingtalk' },
      }),
      specVersion: '1.0',
      type: 'CALLBACK',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.address.channelType, 'dingtalk');
    assert.equal(inbound?.address.chatId, 'cid-1');
    assert.equal(inbound?.address.userId, 'user-1');
    assert.equal(inbound?.text, 'hello dingtalk');

    assert.deepStrictEqual(acked, [
      { messageId: 'stream-msg-1', payload: {} },
    ]);
    assert.equal((adapter as any).replySessions.get('cid-1').sessionWebhook, 'https://example.com/webhook');
  });

  it('parses richText image callbacks into attachments', async () => {
    const adapter = new DingTalkAdapter();
    const acked: string[] = [];
    let fetchStep = 0;

    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchStep += 1;
      if (fetchStep === 1) {
        assert.equal(String(url), 'https://api.dingtalk.com/v1.0/oauth2/accessToken');
        return new Response(JSON.stringify({ accessToken: 'token-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fetchStep === 2) {
        assert.equal(String(url), 'https://api.dingtalk.com/v1.0/robot/messageFiles/download');
        assert.equal((init?.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'token-1');
        return new Response(JSON.stringify({ downloadUrl: 'https://download.example.com/image.png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Uint8Array.from([0x89, 0x50, 0x4E, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof global.fetch;

    (adapter as any).client = {
      socketCallBackResponse: (messageId: string) => {
        acked.push(messageId);
      },
    };

    await (adapter as any).handleRobotCallback({
      headers: {
        appId: 'app',
        connectionId: 'conn',
        contentType: 'application/json',
        messageId: 'stream-img-1',
        time: String(Date.now()),
        topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgId: 'robot-img-1',
        conversationId: 'cid-image',
        conversationType: '1',
        senderStaffId: 'user-1',
        senderId: '$:sender',
        senderNick: 'Alice',
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 60_000,
        createAt: Date.now(),
        msgtype: 'picture',
        robotCode: 'dingbot-code',
        content: {
          richText: [
            {
              type: 'picture',
              text: '请分析这张图',
              downloadCode: 'download-code-1',
              fileName: 'demo-image',
            },
          ],
        },
      }),
      specVersion: '1.0',
      type: 'CALLBACK',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '请分析这张图');
    assert.equal(inbound?.attachments?.length, 1);
    assert.equal(inbound?.attachments?.[0].name, 'demo-image.png');
    assert.equal(inbound?.attachments?.[0].type, 'image/png');
    assert.equal(inbound?.attachments?.[0].filePath, 'https://download.example.com/image.png');
    assert.deepStrictEqual(acked, ['stream-img-1']);
  });

  it('filters group messages without mention when require_mention is enabled', async () => {
    setupContext(createMockStore({
      bridge_dingtalk_enabled: 'true',
      bridge_dingtalk_client_id: 'client-id',
      bridge_dingtalk_client_secret: 'client-secret',
      bridge_dingtalk_group_policy: 'open',
    }));

    const adapter = new DingTalkAdapter();
    const acked: string[] = [];

    (adapter as any).client = {
      socketCallBackResponse: (messageId: string) => {
        acked.push(messageId);
      },
    };

    await (adapter as any).handleRobotCallback({
      headers: {
        appId: 'app',
        connectionId: 'conn',
        contentType: 'application/json',
        messageId: 'stream-msg-2',
        time: String(Date.now()),
        topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgId: 'robot-msg-2',
        conversationId: 'cid-group',
        conversationType: '2',
        senderStaffId: 'user-1',
        senderId: '$:sender',
        senderNick: 'Alice',
        sessionWebhook: 'https://example.com/webhook',
        sessionWebhookExpiredTime: Date.now() + 60_000,
        createAt: Date.now(),
        isInAtList: false,
        msgtype: 'text',
        text: { content: 'hello group' },
      }),
      specVersion: '1.0',
      type: 'CALLBACK',
    });

    assert.equal(await adapter.consumeOne(), null);
    assert.deepStrictEqual(acked, ['stream-msg-2']);
  });

  it('sends markdown replies through sessionWebhook', async () => {
    const adapter = new DingTalkAdapter();
    (adapter as any).replySessions.set('cid-1', {
      sessionWebhook: 'https://example.com/webhook',
      expiresAt: Date.now() + 60_000,
    });

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ errcode: 0, messageId: 'sent-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof global.fetch;

    const result = await adapter.send({
      address: { channelType: 'dingtalk', chatId: 'cid-1' },
      text: '# Title\n\nhello',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://example.com/webhook');
    assert.equal(fetchCalls[0].init?.method, 'POST');
    assert.deepStrictEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      msgtype: 'markdown',
      markdown: {
        title: 'Title',
        text: '# Title\n\nhello',
      },
    });
  });

  it('retries with access token when webhook rejects the first request', async () => {
    const adapter = new DingTalkAdapter();
    (adapter as any).replySessions.set('cid-1', {
      sessionWebhook: 'https://example.com/webhook',
      expiresAt: Date.now() + 60_000,
    });

    let callCount = 0;
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ errcode: 401, errmsg: 'token expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (callCount === 2) {
        assert.equal(String(url), 'https://api.dingtalk.com/v1.0/oauth2/accessToken');
        return new Response(JSON.stringify({ accessToken: 'access-token-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      assert.equal((init?.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'access-token-1');
      return new Response(JSON.stringify({ errcode: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof global.fetch;

    const result = await adapter.send({
      address: { channelType: 'dingtalk', chatId: 'cid-1' },
      text: 'hello',
      parseMode: 'plain',
    });

    assert.equal(result.ok, true);
    assert.equal(callCount, 3);
  });
});

describe('permission-broker - dingtalk text fallback', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('sends plain text prompt for dingtalk without inline buttons', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockDingtalkAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'perm-msg-1' };
      },
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'dingtalk', chatId: 'cid-1' },
      'perm-1',
      'Bash',
      { command: 'ls -la' },
      'session-1',
    );

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].parseMode, 'plain');
    assert.equal(sentMessages[0].inlineButtons, undefined);
    assert.ok(sentMessages[0].text.includes('/perm allow perm-1'));
  });

  it('stores a pending permission link even when dingtalk returns no messageId', async () => {
    const adapter = createMockDingtalkAdapter({
      sendFn: async () => ({ ok: true, messageId: undefined }),
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'dingtalk', chatId: 'cid-2' },
      'perm-no-msgid',
      'Bash',
      { command: 'echo $JAVA_HOME' },
      'session-1',
    );

    assert.equal(store.permissionLinks.length, 1);
    assert.equal(store.permissionLinks[0].permissionRequestId, 'perm-no-msgid');
    assert.equal(store.permissionLinks[0].chatId, 'cid-2');
    assert.equal(store.permissionLinks[0].messageId, 'perm:perm-no-msgid');
  });
});

describe('dingtalk demo echo response', () => {
  it('includes attachment addresses in markdown reply', async () => {
    const llm = new EchoLLM({ markdown: true, label: 'DingTalk Stream Demo' });
    const stream = llm.streamChat({
      prompt: '请分析附件',
      sessionId: 'session-1',
      workingDirectory: '/Users/xsdlr',
      permissionMode: 'acceptEdits',
      files: [
        {
          id: 'file-1',
          name: 'image.png',
          type: 'image/png',
          size: 123,
          data: 'ZmFrZQ==',
          filePath: 'https://download.example.com/image.png',
        },
      ],
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const payload = chunks.join('');
    assert.match(payload, /Files:/);
    assert.match(payload, /image\.png -> https:\/\/download\.example\.com\/image\.png/);
  });
});

describe('interactive demo permission gateway', () => {
  it('waits for explicit allow confirmation', async () => {
    const gateway = new InteractivePermissionGateway();
    const toolInput = {
      command: 'printf \'<%s>\\n\' "$JAVA_HOME"',
      description: '打印 JAVA_HOME 环境变量的值',
    };

    const pending = gateway.waitForDecision({
      permissionRequestId: 'perm-allow-1',
      toolUseID: 'tool-use-1',
      toolInput,
      signal: new AbortController().signal,
    });

    assert.equal(gateway.resolvePendingPermission('perm-allow-1', {
      behavior: 'allow',
    }), true);

    await assert.doesNotReject(async () => {
      const result = await pending;
      assert.equal(result.behavior, 'allow');
      assert.equal(result.toolUseID, 'tool-use-1');
      if (result.behavior === 'allow') {
        assert.deepEqual(result.updatedInput, toolInput);
      }
    });
  });

  it('waits for explicit deny confirmation', async () => {
    const gateway = new InteractivePermissionGateway();

    const pending = gateway.waitForDecision({
      permissionRequestId: 'perm-deny-1',
      toolUseID: 'tool-use-2',
      toolInput: {
        command: 'echo test',
      },
      signal: new AbortController().signal,
    });

    assert.equal(gateway.resolvePendingPermission('perm-deny-1', {
      behavior: 'deny',
      message: 'Denied in chat',
    }), true);

    const result = await pending;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.toolUseID, 'tool-use-2');
    if (result.behavior === 'deny') {
      assert.equal(result.message, 'Denied in chat');
    }
  });

  it('passes through updatedPermissions without broadening scope', async () => {
    const gateway = new InteractivePermissionGateway();

    const pending = gateway.waitForDecision({
      permissionRequestId: 'perm-session-1',
      toolUseID: 'tool-use-3',
      toolInput: {
        command: 'echo "$JAVA_HOME"',
        description: '显示 JAVA_HOME 环境变量',
      },
      signal: new AbortController().signal,
    });

    assert.equal(gateway.resolvePendingPermission('perm-session-1', {
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [
            {
              toolName: 'Bash',
              ruleContent: 'echo "$JAVA_HOME"',
            },
          ],
        },
      ],
    }), true);

    const result = await pending;
    assert.equal(result.behavior, 'allow');
    if (result.behavior === 'allow') {
      assert.deepEqual(result.updatedInput, {
        command: 'echo "$JAVA_HOME"',
        description: '显示 JAVA_HOME 环境变量',
      });
      assert.deepEqual(result.updatedPermissions, [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [
            {
              toolName: 'Bash',
              ruleContent: 'echo "$JAVA_HOME"',
            },
          ],
        },
      ]);
    }
  });
});
