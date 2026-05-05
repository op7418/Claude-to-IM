import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

class TestAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'test-channel';

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return false; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(_message: OutboundMessage): Promise<SendResult> { return { ok: true }; }
  validateConfig(): string | null { return null; }
  isAuthorized(_userId: string, _chatId: string): boolean { return true; }
}

describe('BaseChannelAdapter instanceKey', () => {
  test('defaults to channelType', () => {
    const adapter = new TestAdapter();
    assert.equal(adapter.instanceKey, adapter.channelType);
    assert.equal(adapter.instanceKey, 'test-channel');
  });
});
