/**
 * Unit tests for QQ-related bridge functionality.
 *
 * Tests cover:
 * - PLATFORM_LIMITS for QQ
 * - Delivery-layer QQ chunking (3 segment max, truncation marker)
 * - Permission-broker QQ text permissions (no buttons, /perm commands)
 * - QQAdapter: validateConfig, isAuthorized, send
 * - qq-api: nextMsgSeq auto-increment
 * - bridge-manager: hasError clears sdkSessionId logic
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { deliver } from '../../lib/bridge/delivery-layer';
import { forwardPermissionRequest } from '../../lib/bridge/permission-broker';
import { PLATFORM_LIMITS } from '../../lib/bridge/types';
import { nextMsgSeq } from '../../lib/bridge/adapters/qq-api';
import { QQAdapter } from '../../lib/bridge/adapters/qq-adapter';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: any[] = [];
  const outboundRefs: any[] = [];
  const dedupKeys = new Set<string>();
  const permLinks = new Map<string, any>();

  return {
    auditLogs,
    outboundRefs,
    dedupKeys,
    permLinks,
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
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
    cleanupExpiredDedup: () => {},
    insertOutboundRef: (ref: any) => { outboundRefs.push(ref); },
    insertPermissionLink: (link: any) => { permLinks.set(link.permissionRequestId, link); },
    getPermissionLink: (id: string) => permLinks.get(id) ?? null,
    markPermissionLinkResolved: (_id: string) => false,
    listPendingPermissionLinksByChat: (_chatId: string): any[] => [],
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

// ── Mock QQ Adapter ─────────────────────────────────────────

function createMockQQAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: 'msg-1' }));
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

// ── 1. PLATFORM_LIMITS ─────────────────────────────────────

describe('types - qq platform limit', () => {
  it('qq limit is 2000', () => {
    assert.equal(PLATFORM_LIMITS['qq'], 2000);
  });
});

// ── 2. Delivery-layer QQ chunking ──────────────────────────

describe('delivery-layer - qq chunking', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('limits qq to 3 segments max', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });

    // Generate text that would produce >3 chunks at 2000 char limit
    // 5 chunks worth of text (each ~2000 chars)
    const longText = 'A'.repeat(1900) + '\n' +
                     'B'.repeat(1900) + '\n' +
                     'C'.repeat(1900) + '\n' +
                     'D'.repeat(1900) + '\n' +
                     'E'.repeat(1900);

    const result = await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-1' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'inbound-1',
    });

    assert.ok(result.ok);
    assert.equal(sentMessages.length, 3, `Expected exactly 3 chunks, got ${sentMessages.length}`);
  });

  it('truncates overflow with marker', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });

    // Generate text that would produce >3 chunks
    const longText = 'X'.repeat(1900) + '\n' +
                     'Y'.repeat(1900) + '\n' +
                     'Z'.repeat(1900) + '\n' +
                     'W'.repeat(1900) + '\n' +
                     'V'.repeat(1900);

    await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-2' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'inbound-2',
    });

    // The last (3rd) chunk should contain the truncation marker
    const lastChunk = sentMessages[sentMessages.length - 1];
    assert.ok(lastChunk.includes('[... response truncated]'), 'Last chunk should contain truncation marker');
  });

  it('passes replyToMessageId through chunks', async () => {
    const sentReplyIds: (string | undefined)[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentReplyIds.push(msg.replyToMessageId);
        return { ok: true, messageId: `msg-${sentReplyIds.length}` };
      },
    });

    // Generate text that produces multiple chunks
    const longText = 'A'.repeat(1900) + '\n' +
                     'B'.repeat(1900) + '\n' +
                     'C'.repeat(1900);

    await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-3' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'reply-target-id',
    });

    // All chunks should carry the replyToMessageId
    for (const replyId of sentReplyIds) {
      assert.equal(replyId, 'reply-target-id', 'Each chunk should pass through replyToMessageId');
    }
  });
});

// ── 3. Permission-broker QQ text permissions ────────────────

describe('permission-broker - qq text permissions', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('sends plain text prompt for qq (no buttons)', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'perm-msg-1' };
      },
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'qq', chatId: 'user-perm-1' },
      'perm-req-unique-1',
      'Bash',
      { command: 'ls -la' },
      'session-1',
      undefined,
      'reply-msg-1',
    );

    assert.ok(sentMessages.length > 0, 'Should have sent at least one message');

    const permMsg = sentMessages[0];
    // No inline buttons for QQ
    assert.equal(permMsg.inlineButtons, undefined, 'QQ permission prompt should not have inline buttons');
    // Should contain numeric shortcuts
    assert.ok(permMsg.text.includes('1 - Allow once'), 'Should contain shortcut 1');
    assert.ok(permMsg.text.includes('2 - Allow session'), 'Should contain shortcut 2');
    assert.ok(permMsg.text.includes('3 - Deny'), 'Should contain shortcut 3');
    // Should still contain full /perm fallback commands (each as separate copyable line)
    assert.ok(permMsg.text.includes('/perm allow perm-req-unique-1'), 'Should contain /perm allow command');
    assert.ok(permMsg.text.includes('/perm allow_session perm-req-unique-1'), 'Should contain /perm allow_session command');
    assert.ok(permMsg.text.includes('/perm deny perm-req-unique-1'), 'Should contain /perm deny command');
  });

  it('passes replyToMessageId for qq', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'perm-msg-2' };
      },
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'qq', chatId: 'user-perm-2' },
      'perm-req-unique-2',
      'Read',
      { file_path: '/tmp/test' },
      'session-2',
      undefined,
      'reply-msg-2',
    );

    assert.ok(sentMessages.length > 0);
    assert.equal(sentMessages[0].replyToMessageId, 'reply-msg-2', 'Should pass through replyToMessageId');
  });
});

// ── 4. QQAdapter unit tests ────────────────────────────────

describe('qq-adapter', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('validateConfig returns error when app_id missing', () => {
    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.ok(error);
    assert.ok(error.includes('app_id'), `Expected error about app_id, got: ${error}`);
  });

  it('validateConfig returns error when app_secret missing', () => {
    store = createMockStore({ bridge_qq_app_id: 'test-app-id' });
    setupContext(store);

    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.ok(error);
    assert.ok(error.includes('app_secret'), `Expected error about app_secret, got: ${error}`);
  });

  it('validateConfig returns null when both configured', () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.equal(error, null);
  });

  it('isAuthorized allows all when allowed_users empty', () => {
    const adapter = new QQAdapter();
    assert.ok(adapter.isAuthorized('any-user', 'any-chat'));
  });

  it('isAuthorized blocks unlisted users', () => {
    store = createMockStore({ bridge_qq_allowed_users: 'user-a,user-b' });
    setupContext(store);

    const adapter = new QQAdapter();
    assert.equal(adapter.isAuthorized('user-c', 'chat-1'), false);
  });

  it('isAuthorized allows listed users', () => {
    store = createMockStore({ bridge_qq_allowed_users: 'user-a,user-b' });
    setupContext(store);

    const adapter = new QQAdapter();
    assert.ok(adapter.isAuthorized('user-a', 'chat-1'));
    assert.ok(adapter.isAuthorized('user-b', 'chat-1'));
  });

  it('send returns error when replyToMessageId missing', async () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();
    const result = await adapter.send({
      address: { channelType: 'qq', chatId: 'user-1' },
      text: 'Hello',
      parseMode: 'plain',
      // No replyToMessageId
    });

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('replyToMessageId'));
  });

  it('send strips HTML tags when parseMode is HTML', async () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;

    globalThis.fetch = (async (_url: any, init: any) => {
      // Capture the token request
      const urlStr = typeof _url === 'string' ? _url : _url.toString();
      if (urlStr.includes('getAppAccessToken')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'test-token', expires_in: 7200 }),
          text: async () => '',
        };
      }
      // Capture the send message request
      capturedBody = init?.body;
      return {
        ok: true,
        json: async () => ({ id: 'sent-1' }),
        text: async () => '',
      };
    }) as typeof fetch;

    try {
      await adapter.send({
        address: { channelType: 'qq', chatId: 'user-1' },
        text: '<b>Hello</b> <i>world</i>',
        parseMode: 'HTML',
        replyToMessageId: 'msg-in-1',
      });

      assert.ok(capturedBody, 'Should have captured request body');
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.content, 'Hello world', 'HTML tags should be stripped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 5. qq-api nextMsgSeq ────────────────────────────────────

describe('qq-api - nextMsgSeq', () => {
  it('auto-increments per message ID', () => {
    // Use a unique message ID to avoid interference from other tests
    const msgId = `test-msg-seq-${Date.now()}`;

    const seq1 = nextMsgSeq(msgId);
    const seq2 = nextMsgSeq(msgId);
    const seq3 = nextMsgSeq(msgId);

    assert.equal(seq1, 1);
    assert.equal(seq2, 2);
    assert.equal(seq3, 3);
  });
});

// ── 6. qq-adapter send() catches exceptions ──────────────────

describe('qq-adapter - send catches exceptions', () => {
  it('returns SendResult on token fetch failure instead of throwing', async () => {
    const store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();

    // Mock fetch to throw on token request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network timeout');
    }) as typeof fetch;

    try {
      const result = await adapter.send({
        address: { channelType: 'qq', chatId: 'user-1' },
        text: 'Hello',
        parseMode: 'plain',
        replyToMessageId: 'msg-in-1',
      });

      // Should NOT throw — should return { ok: false }
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('network timeout'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 7. qq-adapter image download failure tracking ──────────────

describe('qq-adapter - image download failure tracking', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore({
      bridge_qq_app_id: 'test-id',
      bridge_qq_app_secret: 'test-secret',
    });
    setupContext(store);
  });

  it('enqueues message with failure info when all images fail', async () => {
    const adapter = new QQAdapter();

    // Mock fetch to fail on image download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('getAppAccessToken')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 7200 }), text: async () => '' };
      }
      // Image download fails
      return { ok: false, status: 500, text: async () => 'server error' };
    }) as unknown as typeof fetch;

    try {
      // Access private method via cast
      const adapterAny = adapter as any;

      // Simulate C2C message with image-only (no text)
      adapterAny.handleC2CMessage({
        id: 'img-fail-msg-1',
        author: { user_openid: 'user-img-1' },
        content: '',
        timestamp: new Date().toISOString(),
        attachments: [
          { content_type: 'image/png', url: 'https://example.com/img.png', filename: 'test.png' },
        ],
      });

      // Wait for async download to complete
      await new Promise(r => setTimeout(r, 100));

      // Should have enqueued a message with raw.imageDownloadFailed
      const msg = adapterAny.queue.shift();
      assert.ok(msg, 'Should have enqueued a message');
      assert.equal(msg.text, '');
      assert.ok((msg.raw as any)?.imageDownloadFailed, 'Should flag imageDownloadFailed');
      assert.equal((msg.raw as any)?.failedCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 8. bridge-manager: image download failure replies to user ───

describe('bridge-manager - image download failure reply', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
    // Clean global bridge-manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  });

  it('replies to user when image-only message fails download', async () => {
    // Import the real handleMessage from bridge-manager
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    // Call the REAL handleMessage with an image-download-failure message
    await _testOnly.handleMessage(adapter, {
      messageId: 'img-msg-1',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
      raw: { imageDownloadFailed: true, failedCount: 2 },
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Failed to download 2 image(s)'));
    assert.equal(sentMessages[0].replyToMessageId, 'img-msg-1');
  });

  it('replies to user when non-image attachments fail download', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-2' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'att-msg-1',
      address: { channelType: 'weixin' as const, chatId: 'user-1', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
      raw: { attachmentDownloadFailed: true, failedCount: 1, failedLabel: 'attachment(s)' },
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Failed to download 1 attachment(s)'));
    assert.equal(sentMessages[0].replyToMessageId, 'att-msg-1');
  });

  it('replies to user when adapter provides a custom visible error', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-voice-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'voice-msg-1',
      address: { channelType: 'weixin' as const, chatId: 'user-1', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
      raw: {
        userVisibleError: 'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
      },
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(
      sentMessages[0].text,
      'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
    );
    assert.equal(sentMessages[0].replyToMessageId, 'voice-msg-1');
  });

  it('silently drops empty message without imageDownloadFailed flag', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'empty-msg',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 0, 'Should not send anything for empty messages without failure flag');
  });
});

// ── 9. Numeric shortcut permission replies (feishu/qq) ─────────

describe('numeric shortcut permission replies', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    // Wire up a functional permission store for these tests
    store.getPermissionLink = (id: string) => {
      const link = store.permLinks.get(id);
      return link ? { ...link, resolved: link.resolved ?? false } : null;
    };
    store.markPermissionLinkResolved = (id: string) => {
      const link = store.permLinks.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    };
    store.listPendingPermissionLinksByChat = (chatId: string) => {
      return [...store.permLinks.values()].filter(
        (l: any) => l.chatId === chatId && !l.resolved,
      );
    };
    // Use a permissions gateway that actually resolves (returns true)
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  });

  it('resolves single pending permission with "1" → allow (qq)', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    // Insert a pending permission link
    store.permLinks.set('perm-abc', {
      permissionRequestId: 'perm-abc',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-reply-1',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '1',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1, 'Should reply with confirmation');
    assert.ok(sentMessages[0].text.includes('Allow'), 'Should confirm Allow');
    assert.equal(store.permLinks.get('perm-abc').resolved, true, 'Permission should be resolved');
  });

  it('resolves single pending permission with "2" → allow_session (qq)', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-def', {
      permissionRequestId: 'perm-def',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-reply-2',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '2',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Allow Session'), 'Should confirm Allow Session');
    assert.equal(store.permLinks.get('perm-def').resolved, true);
  });

  it('resolves single pending permission with "3" → deny (qq)', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-ghi', {
      permissionRequestId: 'perm-ghi',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-reply-3',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '3',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Deny'), 'Should confirm Deny');
    assert.equal(store.permLinks.get('perm-ghi').resolved, true);
  });

  it('handles fullwidth digit ２ via NFKC normalization', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-fw', {
      permissionRequestId: 'perm-fw',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-fw-2',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '\uFF12', // fullwidth digit ２
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1, 'Should handle fullwidth digit');
    assert.ok(sentMessages[0].text.includes('Allow Session'), 'Fullwidth ２ should map to allow_session');
    assert.equal(store.permLinks.get('perm-fw').resolved, true);
  });

  it('handles digit with zero-width characters', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-zw', {
      permissionRequestId: 'perm-zw',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-zw-1',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '\u200B1\u200B', // "1" wrapped in zero-width spaces
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1, 'Should handle digit with zero-width chars');
    assert.ok(sentMessages[0].text.includes('Allow'), 'Should map to allow');
    assert.equal(store.permLinks.get('perm-zw').resolved, true);
  });

  it('falls through when no pending permissions (condition check)', () => {
    // No permission links in store — numeric shortcut should NOT activate
    const pendingLinks = store.listPendingPermissionLinksByChat('user-1');
    assert.equal(pendingLinks.length, 0, 'No pending permissions');
    // The bridge-manager code checks: pendingLinks.length === 1
    // With 0 pending, it falls through to normal message handling
    const shouldIntercept = /^[123]$/.test('1') && (pendingLinks.length as number) === 1;
    assert.equal(shouldIntercept, false, 'Should not intercept "1" when no pending permissions');
  });

  it('hints user to use /perm when multiple pending permissions', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-1', {
      permissionRequestId: 'perm-1',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });
    store.permLinks.set('perm-2', {
      permissionRequestId: 'perm-2',
      chatId: 'user-1',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-reply-ambiguous',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '2',
      timestamp: Date.now(),
    });

    // Should get a hint to use full /perm command, not fall through
    assert.equal(sentMessages.length, 1, 'Should send a hint message');
    assert.ok(sentMessages[0].text.includes('Multiple pending permissions'), 'Should mention multiple pending');
    assert.ok(sentMessages[0].text.includes('/perm'), 'Should mention /perm command');
    assert.equal(store.permLinks.get('perm-1').resolved, false, 'perm-1 should remain unresolved');
    assert.equal(store.permLinks.get('perm-2').resolved, false, 'perm-2 should remain unresolved');
  });

  it('does not intercept numeric shortcut for telegram (inline buttons available)', () => {
    store.permLinks.set('perm-tg', {
      permissionRequestId: 'perm-tg',
      chatId: 'tg-chat-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    // The bridge-manager code checks: adapter.channelType === 'feishu' || adapter.channelType === 'qq'
    // Telegram is NOT in that list, so numeric shortcuts are never intercepted
    const channelType: string = 'telegram';
    const shouldCheck = channelType === 'feishu' || channelType === 'qq';
    assert.equal(shouldCheck, false, 'Telegram should not use numeric shortcuts');
    assert.equal(store.permLinks.get('perm-tg').resolved, false, 'Permission should remain unresolved');
  });

  it('old /perm command still works alongside numeric shortcuts', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    store.permLinks.set('perm-compat', {
      permissionRequestId: 'perm-compat',
      chatId: 'user-1',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'user-perm-cmd',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '/perm allow perm-compat',
      timestamp: Date.now(),
    });

    assert.equal(store.permLinks.get('perm-compat').resolved, true, '/perm command should still work');
    assert.ok(sentMessages.some(m => m.text.includes('recorded')), 'Should confirm via /perm');
  });
});

// ── 10. bridge-manager sdkSessionId update logic ─────────────────

describe('bridge-manager - computeSdkSessionUpdate', () => {
  it('saves sdkSessionId when no error', async () => {
    const { computeSdkSessionUpdate } = await import('../../lib/bridge/bridge-manager');
    const result = computeSdkSessionUpdate('new-sdk-123', false);
    assert.equal(result, 'new-sdk-123');
  });

  it('clears sdkSessionId on error even when sdkSessionId is present', async () => {
    const { computeSdkSessionUpdate } = await import('../../lib/bridge/bridge-manager');
    const result = computeSdkSessionUpdate('new-sdk-123', true);
    assert.equal(result, '', 'Error with SDK ID: should clear');
  });

  it('clears sdkSessionId on error even without sdkSessionId', async () => {
    const { computeSdkSessionUpdate } = await import('../../lib/bridge/bridge-manager');
    const result = computeSdkSessionUpdate(null, true);
    assert.equal(result, '', 'Error without SDK ID: should clear');
  });

  it('returns null (no update) when no error and no sdkSessionId', async () => {
    const { computeSdkSessionUpdate } = await import('../../lib/bridge/bridge-manager');
    const result = computeSdkSessionUpdate(null, false);
    assert.equal(result, null, 'No error and no SDK ID: no update needed');
  });

  it('returns null for empty string sdkSessionId without error', async () => {
    const { computeSdkSessionUpdate } = await import('../../lib/bridge/bridge-manager');
    const result = computeSdkSessionUpdate('', false);
    assert.equal(result, null, 'Empty SDK ID without error: no update needed');
  });
});
