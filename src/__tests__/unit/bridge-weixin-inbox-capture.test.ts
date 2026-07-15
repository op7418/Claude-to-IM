import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

const tempDirs: string[] = [];

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('bridge-manager weixin inbox capture', () => {
  it('captures ordinary WeChat text into inbox without invoking the LLM', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-weixin-inbox-'));
    tempDirs.push(root);

    const sentMessages: OutboundMessage[] = [];
    const storedMessages: Array<{ role: string; content: string }> = [];
    let llmInvoked = false;

    initBridgeContext({
      store: createInboxStore(root, storedMessages) as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          llmInvoked = true;
          throw new Error('LLM should not be invoked for inbox captures');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(createWeixinAdapter(sentMessages), {
      messageId: 'wx-msg-1',
      address: { channelType: 'weixin', chatId: 'wx-chat-1', userId: 'wx-user-1', displayName: '手机' },
      text: 'https://x.com/example/status/1\n为什么存：这个适合放进个人知识库。',
      timestamp: Date.UTC(2026, 3, 28, 10, 0, 0),
    });

    assert.equal(llmInvoked, false);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /已存入 Inbox I20260428-001/);

    const inboxFile = path.join(root, 'inbox', '2026-04-28.md');
    assert.equal(fs.existsSync(inboxFile), true);
    const inboxText = fs.readFileSync(inboxFile, 'utf8');
    assert.match(inboxText, /https:\/\/x\.com\/example\/status\/1/);
    assert.match(inboxText, /状态：待处理/);

    assert.equal(storedMessages.length, 2);
    assert.match(storedMessages[0].content, /\[手机 inbox\] ID=I20260428-001/);
  });
  it('routes WeChat text to Codex remote controller when enabled without writing legacy inbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-weixin-cwrc-'));
    tempDirs.push(root);

    const adapterPath = path.join(root, 'mock-wechat-adapter.mjs');
    fs.writeFileSync(adapterPath, `
export function createWeChatMessageHandler(options = {}) {
  globalThis.__cwrcOptions = options;
  return async function handleWeChatMessage(message) {
    globalThis.__cwrcCalls = [...(globalThis.__cwrcCalls || []), message];
    return { text: 'CWRC:' + message.content, response: { reply: 'CWRC:' + message.content } };
  };
}
`, 'utf8');
    (globalThis as Record<string, unknown>).__cwrcCalls = [];

    const sentMessages: OutboundMessage[] = [];
    const storedMessages: Array<{ role: string; content: string }> = [];
    let llmInvoked = false;

    initBridgeContext({
      store: createInboxStore(root, storedMessages, {
        bridge_weixin_codex_controller_enabled: 'true',
        bridge_weixin_codex_controller_path: adapterPath,
        bridge_weixin_codex_workspace_root: root,
      }) as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          llmInvoked = true;
          throw new Error('LLM should not be invoked for Codex remote controller messages');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(createWeixinAdapter(sentMessages), {
      messageId: 'wx-msg-cwrc-1',
      address: { channelType: 'weixin', chatId: 'wx-chat-1', userId: 'wx-user-1', displayName: '手机' },
      text: '列表',
      timestamp: Date.UTC(2026, 4, 8, 13, 0, 0),
    });

    assert.equal(llmInvoked, false);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].text, 'CWRC:列表');
    const cwrcCalls = (globalThis as Record<string, unknown>).__cwrcCalls as Array<Record<string, unknown>>;
    assert.equal(typeof cwrcCalls[0].sendReply, 'function');
    delete cwrcCalls[0].sendReply;
    assert.deepEqual(cwrcCalls, [{
      chatId: 'wx-chat-1',
      content: '列表',
      createTime: Date.UTC(2026, 4, 8, 13, 0, 0),
      fromUserName: 'wx-user-1',
      id: 'wx-msg-cwrc-1',
    }]);
    assert.equal(fs.existsSync(path.join(root, 'inbox', '2026-05-08.md')), false);
    assert.equal(storedMessages.length, 0);
  });

  it('passes an async reply callback to the Codex remote controller', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-weixin-cwrc-callback-'));
    tempDirs.push(root);

    const adapterPath = path.join(root, 'mock-wechat-adapter.mjs');
    fs.writeFileSync(adapterPath, `
export function createWeChatMessageHandler() {
  return async function handleWeChatMessage(message) {
    globalThis.__cwrcCalls = [...(globalThis.__cwrcCalls || []), {
      hasSendReply: typeof message.sendReply === 'function',
    }];
    message.sendReply('CWRC async:' + message.content);
    return { text: 'CWRC accepted:' + message.content };
  };
}
`, 'utf8');
    (globalThis as Record<string, unknown>).__cwrcCalls = [];

    const sentMessages: OutboundMessage[] = [];
    const storedMessages: Array<{ role: string; content: string }> = [];

    initBridgeContext({
      store: createInboxStore(root, storedMessages, {
        bridge_weixin_codex_controller_enabled: 'true',
        bridge_weixin_codex_controller_path: adapterPath,
        bridge_weixin_codex_workspace_root: root,
      }) as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be invoked for Codex remote controller messages');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(createWeixinAdapter(sentMessages), {
      messageId: 'wx-msg-cwrc-callback-1',
      address: { channelType: 'weixin', chatId: 'wx-chat-1', userId: 'wx-user-1', displayName: '鎵嬫満' },
      text: '鍒楄〃',
      timestamp: Date.UTC(2026, 4, 8, 13, 0, 0),
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual((globalThis as Record<string, unknown>).__cwrcCalls, [{ hasSendReply: true }]);
    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages.map(message => message.text).sort(), [
      'CWRC accepted:鍒楄〃',
      'CWRC async:鍒楄〃',
    ].sort());
  });

  it('propagates Codex remote controller attachments to WeChat outbound messages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-weixin-cwrc-attachments-'));
    tempDirs.push(root);

    const artifactPath = path.join(root, 'clip.mp4');
    fs.writeFileSync(artifactPath, 'fake video', 'utf8');
    const adapterPath = path.join(root, 'mock-wechat-adapter.mjs');
    fs.writeFileSync(adapterPath, `
export function createWeChatMessageHandler() {
  return async function handleWeChatMessage() {
    return {
      text: '成品如下：clip.mp4',
      attachments: [
        { kind: 'video', path: ${JSON.stringify(artifactPath)}, name: 'clip.mp4', type: 'video/mp4' },
      ],
    };
  };
}
`, 'utf8');

    const sentMessages: OutboundMessage[] = [];
    const storedMessages: Array<{ role: string; content: string }> = [];

    initBridgeContext({
      store: createInboxStore(root, storedMessages, {
        bridge_weixin_codex_controller_enabled: 'true',
        bridge_weixin_codex_controller_path: adapterPath,
        bridge_weixin_codex_workspace_root: root,
      }) as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be invoked for Codex remote controller messages');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(createWeixinAdapter(sentMessages), {
      messageId: 'wx-msg-cwrc-attachment-1',
      address: { channelType: 'weixin', chatId: 'wx-chat-1', userId: 'wx-user-1', displayName: '手机' },
      text: '把视频发给我',
      timestamp: Date.UTC(2026, 4, 8, 13, 0, 0),
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].text, '成品如下：clip.mp4');
    assert.deepEqual(sentMessages[0].attachments, [
      { kind: 'video', path: artifactPath, name: 'clip.mp4', type: 'video/mp4' },
    ]);
  });

  it('does not send a WeChat reply when the Codex remote controller marks output silent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-weixin-cwrc-silent-'));
    tempDirs.push(root);

    const adapterPath = path.join(root, 'mock-wechat-adapter.mjs');
    fs.writeFileSync(adapterPath, `
export function createWeChatMessageHandler() {
  return async function handleWeChatMessage(message) {
    globalThis.__cwrcCalls = [...(globalThis.__cwrcCalls || []), message];
    return { silent: true, text: '', response: { reply: '', silent: true } };
  };
}
`, 'utf8');
    (globalThis as Record<string, unknown>).__cwrcCalls = [];

    const sentMessages: OutboundMessage[] = [];
    const storedMessages: Array<{ role: string; content: string }> = [];
    let llmInvoked = false;

    initBridgeContext({
      store: createInboxStore(root, storedMessages, {
        bridge_weixin_codex_controller_enabled: 'true',
        bridge_weixin_codex_controller_path: adapterPath,
        bridge_weixin_codex_workspace_root: root,
      }) as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          llmInvoked = true;
          throw new Error('LLM should not be invoked for silent Codex remote controller messages');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(createWeixinAdapter(sentMessages), {
      messageId: 'wx-msg-cwrc-silent-1',
      address: { channelType: 'weixin', chatId: 'wx-chat-1', userId: 'wx-user-1', displayName: '手机' },
      text: '知识库：只沉淀不回复',
      timestamp: Date.UTC(2026, 4, 8, 13, 0, 0),
    });

    assert.equal(llmInvoked, false);
    assert.equal(sentMessages.length, 0);
    const cwrcCalls = (globalThis as Record<string, unknown>).__cwrcCalls as Array<Record<string, unknown>>;
    assert.equal(typeof cwrcCalls[0].sendReply, 'function');
    delete cwrcCalls[0].sendReply;
    assert.deepEqual(cwrcCalls, [{
      chatId: 'wx-chat-1',
      content: '知识库：只沉淀不回复',
      createTime: Date.UTC(2026, 4, 8, 13, 0, 0),
      fromUserName: 'wx-user-1',
      id: 'wx-msg-cwrc-silent-1',
    }]);
    assert.equal(fs.existsSync(path.join(root, 'inbox', '2026-05-08.md')), false);
    assert.equal(storedMessages.length, 0);
  });
});

function createWeixinAdapter(sentMessages: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'weixin',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (msg: OutboundMessage): Promise<SendResult> => {
      sentMessages.push(msg);
      return { ok: true, messageId: 'reply-1' };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

function createInboxStore(
  workingDirectory: string,
  storedMessages: Array<{ role: string; content: string }>,
  settings: Record<string, string> = {},
) {
  const auditLogs: unknown[] = [];
  const dedupKeys = new Set<string>();

  return {
    auditLogs,
    getSetting: (key: string) => {
      if (key in settings) return settings[key];
      return key === 'bridge_default_work_dir' ? workingDirectory : null;
    },
    getChannelBinding: () => null,
    upsertChannelBinding: (binding: Partial<ChannelBinding>) => ({
      id: 'binding-1',
      channelType: binding.channelType || 'weixin',
      chatId: binding.chatId || 'wx-chat-1',
      codepilotSessionId: binding.codepilotSessionId || 'session-1',
      sdkSessionId: binding.sdkSessionId || '',
      workingDirectory: binding.workingDirectory || workingDirectory,
      model: binding.model || '',
      mode: binding.mode || 'code',
      active: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: 'session-1', working_directory: workingDirectory, model: '' }),
    updateSessionProviderId: () => {},
    addMessage: (_sessionId: string, role: string, content: string) => {
      storedMessages.push({ role, content });
    },
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
    insertAuditLog: (entry: unknown) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
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
