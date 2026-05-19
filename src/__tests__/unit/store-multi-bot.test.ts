import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../../store';

describe('JsonFileStore multi-bot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('constructor with dataDir uses custom path', () => {
    const customDir = path.join(tmpDir, 'bot-jason');
    fs.mkdirSync(customDir, { recursive: true });
    const settings = new Map<string, string>();
    const store = new JsonFileStore(settings, customDir);

    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_test',
      codepilotSessionId: 'sess_1',
      workingDirectory: '/tmp/test',
      model: 'claude-3',
      botName: 'jason',
    });

    const binding = store.getChannelBinding('feishu', 'oc_test', 'jason');
    assert.ok(binding);
    assert.equal(binding.botName, 'jason');
    assert.ok(fs.existsSync(path.join(customDir, 'bindings.json')));
  });

  test('binding key includes botName when provided', () => {
    const customDir = path.join(tmpDir, 'bot-a');
    fs.mkdirSync(customDir, { recursive: true });
    const store = new JsonFileStore(new Map(), customDir);

    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_same',
      codepilotSessionId: 'sess_a',
      workingDirectory: '/tmp/a',
      model: 'claude-3',
      botName: 'botA',
    });

    const miss = store.getChannelBinding('feishu', 'oc_same');
    const hit = store.getChannelBinding('feishu', 'oc_same', 'botA');
    assert.equal(miss, null);
    assert.ok(hit);
    assert.equal(hit.codepilotSessionId, 'sess_a');
  });

  test('two stores with different dataDirs are isolated', () => {
    const dirA = path.join(tmpDir, 'bot-a');
    const dirB = path.join(tmpDir, 'bot-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const storeA = new JsonFileStore(new Map(), dirA);
    const storeB = new JsonFileStore(new Map(), dirB);

    storeA.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_1',
      codepilotSessionId: 'sess_a',
      workingDirectory: '/a',
      model: 'claude-3',
      botName: 'a',
    });

    const fromB = storeB.getChannelBinding('feishu', 'oc_1', 'a');
    assert.equal(fromB, null);
  });
});
