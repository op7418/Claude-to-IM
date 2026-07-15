import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureInboxMessage,
  parseInboxCaptureMessage,
  resolveInboxStorage,
} from '../../lib/bridge/material-inbox.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('bridge material inbox parser', () => {
  it('recognizes phone capture prefixes', () => {
    assert.deepEqual(parseInboxCaptureMessage('素材：这里是一段素材'), {
      kind: '素材',
      rawPrefix: '素材',
      label: '',
      body: '这里是一段素材',
    });

    assert.deepEqual(parseInboxCaptureMessage('灵感 知识库：链接\n为什么存：可以改造个人知识库'), {
      kind: '灵感',
      rawPrefix: '灵感 知识库',
      label: '知识库',
      body: '链接\n为什么存：可以改造个人知识库',
    });

    assert.deepEqual(parseInboxCaptureMessage('inbox AI agents: https://x.com/example/status/1'), {
      kind: 'inbox',
      rawPrefix: 'inbox AI agents',
      label: 'AI agents',
      body: 'https://x.com/example/status/1',
    });
  });

  it('ignores normal conversation text', () => {
    assert.equal(parseInboxCaptureMessage('帮我抓一下今天热点'), null);
  });

  it('treats bare text as inbox capture only when explicitly allowed', () => {
    assert.deepEqual(parseInboxCaptureMessage('https://x.com/example/status/1\n为什么存：知识库参考', { allowBare: true }), {
      kind: 'inbox',
      rawPrefix: '',
      label: '',
      body: 'https://x.com/example/status/1\n为什么存：知识库参考',
    });
    assert.equal(parseInboxCaptureMessage('https://x.com/example/status/1', { allowBare: false }), null);
  });
});

describe('bridge material inbox storage', () => {
  it('prefers tech_wechat subdirectories when present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-material-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'tech_wechat'), { recursive: true });

    const resolved = resolveInboxStorage(root);

    assert.equal(resolved.rootDir, path.join(root, 'tech_wechat'));
    assert.equal(resolved.inboxDir, path.join(root, 'tech_wechat', 'inbox'));
    assert.equal(resolved.indexFile, path.join(root, 'tech_wechat', 'data', 'bridge-inbox-index.json'));
  });

  it('appends captures to a daily inbox file and updates the recent index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-material-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'tech_wechat'), { recursive: true });

    const captured = captureInboxMessage({
      workingDirectory: root,
      channelType: 'weixin',
      chatId: 'wx-chat-1',
      messageId: 'msg-001',
      timestamp: Date.UTC(2026, 3, 2, 10, 0, 0),
      displayName: '手机素材',
      rawText: '灵感 知识库：AI 眼镜不重要，重要的是它开始取代“打开 App”这个动作。\n\n为什么存：可以提醒我关注入口变化。',
    });

    assert.match(captured.inboxId, /^I20260402-\d{3}$/);
    assert.equal(captured.relativePath, 'tech_wechat/inbox/2026-04-02.md');
    assert.equal(fs.existsSync(captured.absolutePath), true);

    const fileText = fs.readFileSync(captured.absolutePath, 'utf8');
    assert.match(fileText, /# 2026-04-02 微信 Inbox/);
    assert.match(fileText, /## I20260402-\d{3} · 知识库/);
    assert.match(fileText, /AI 眼镜不重要/);
    assert.match(fileText, /来源渠道：weixin/);
    assert.match(fileText, /状态：待处理/);

    const index = JSON.parse(
      fs.readFileSync(path.join(root, 'tech_wechat', 'data', 'bridge-inbox-index.json'), 'utf8'),
    );

    assert.equal(index.version, 1);
    assert.equal(index.recentByChat['weixin:wx-chat-1'][0].id, captured.inboxId);
    assert.equal(index.recentByChat['weixin:wx-chat-1'][0].relativePath, captured.relativePath);
  });

  it('captures bare phone text when allowBare is enabled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-material-'));
    tempDirs.push(root);

    const captured = captureInboxMessage({
      workingDirectory: root,
      channelType: 'weixin',
      chatId: 'wx-chat-1',
      messageId: 'msg-002',
      timestamp: Date.UTC(2026, 3, 28, 10, 0, 0),
      rawText: 'https://mp.weixin.qq.com/s/example\n为什么存：这篇文章可以作为知识库入口设计参考。',
      allowBare: true,
    });

    assert.match(captured.inboxId, /^I20260428-\d{3}$/);
    assert.equal(captured.kind, 'inbox');
    assert.equal(captured.relativePath, 'inbox/2026-04-28.md');

    const fileText = fs.readFileSync(captured.absolutePath, 'utf8');
    assert.match(fileText, /https:\/\/mp\.weixin\.qq\.com\/s\/example/);
    assert.match(fileText, /为什么存：这篇文章可以作为知识库入口设计参考。/);
  });
});
