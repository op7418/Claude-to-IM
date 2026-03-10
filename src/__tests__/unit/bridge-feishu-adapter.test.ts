import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCardActionCallbackData,
  buildPermissionCardActionResponse,
} from '../../lib/bridge/adapters/feishu-adapter.js';

describe('feishu-adapter card actions', () => {
  it('extracts callback data from object value payload', () => {
    const callbackData = extractCardActionCallbackData({
      value: { callback_data: 'perm:allow:perm-1' },
    });

    assert.equal(callbackData, 'perm:allow:perm-1');
  });

  it('extracts callback data from legacy string value payload', () => {
    const callbackData = extractCardActionCallbackData({
      value: 'perm:deny:perm-2',
    });

    assert.equal(callbackData, 'perm:deny:perm-2');
  });

  it('builds an immediate card update response for allow_session', () => {
    const response = buildPermissionCardActionResponse('perm:allow_session:perm-3');

    assert.equal(response.toast?.type, 'success');
    assert.equal(response.toast?.content, 'Session Allowed');
    assert.equal(response.card?.type, 'raw');
    assert.equal(response.card?.data.schema, '2.0');
    assert.match(response.card?.data.body.elements[0].content || '', /Session Allowed/);
  });
});
