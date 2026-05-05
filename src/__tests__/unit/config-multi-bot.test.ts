import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuBotConfigs } from '../../config';

describe('parseFeishuBotConfigs', () => {
  test('parses multiple bots', () => {
    const env = new Map<string, string>([
      ['CTI_FEISHU_BOTS_0_NAME', 'ccbot'],
      ['CTI_FEISHU_BOTS_0_APP_ID', 'cli_aaa'],
      ['CTI_FEISHU_BOTS_0_APP_SECRET', 'secret_aaa'],
      ['CTI_FEISHU_BOTS_0_DOMAIN', 'feishu'],
      ['CTI_FEISHU_BOTS_0_ALLOWED_USERS', 'ou_1,ou_2'],
      ['CTI_FEISHU_BOTS_0_REQUIRE_MENTION', 'false'],
      ['CTI_FEISHU_BOTS_0_WORKING_DIR', '~/Claude Code'],
      ['CTI_FEISHU_BOTS_0_GROUP_POLICY', 'allowlist'],
      ['CTI_FEISHU_BOTS_0_GROUP_ALLOW_FROM', 'oc_xxx'],
      ['CTI_FEISHU_BOTS_0_USER_ou_2_WORKING_DIR', '~/workspace-aixin'],
      ['CTI_FEISHU_BOTS_1_NAME', 'jason'],
      ['CTI_FEISHU_BOTS_1_APP_ID', 'cli_bbb'],
      ['CTI_FEISHU_BOTS_1_APP_SECRET', 'secret_bbb'],
      ['CTI_FEISHU_BOTS_1_WORKING_DIR', '~/tenant-jason'],
    ]);

    const bots = parseFeishuBotConfigs(env);
    assert.equal(bots.length, 2);

    assert.equal(bots[0].name, 'ccbot');
    assert.equal(bots[0].appId, 'cli_aaa');
    assert.deepEqual(bots[0].allowedUsers, ['ou_1', 'ou_2']);
    assert.equal(bots[0].requireMention, false);
    assert.equal(bots[0].domain, 'feishu');
    assert.equal(bots[0].groupPolicy, 'allowlist');
    assert.deepEqual(bots[0].groupAllowFrom, ['oc_xxx']);
    assert.equal(bots[0].workingDirectory, '~/Claude Code');
    assert.equal(bots[0].userOverrides?.get('ou_2')?.workingDirectory, '~/workspace-aixin');

    assert.equal(bots[1].name, 'jason');
    assert.equal(bots[1].appId, 'cli_bbb');
    assert.equal(bots[1].workingDirectory, '~/tenant-jason');
    assert.equal(bots[1].domain, undefined);
  });

  test('throws when NAME is missing', () => {
    const env = new Map<string, string>([
      ['CTI_FEISHU_BOTS_0_APP_ID', 'cli_xxx'],
      ['CTI_FEISHU_BOTS_0_APP_SECRET', 'secret'],
    ]);

    assert.throws(() => parseFeishuBotConfigs(env), /NAME/i);
  });

  test('throws when APP_ID is missing', () => {
    const env = new Map<string, string>([
      ['CTI_FEISHU_BOTS_0_NAME', 'ccbot'],
      ['CTI_FEISHU_BOTS_0_APP_SECRET', 'secret'],
    ]);

    assert.throws(() => parseFeishuBotConfigs(env), /APP_ID/i);
  });

  test('throws when APP_SECRET is missing', () => {
    const env = new Map<string, string>([
      ['CTI_FEISHU_BOTS_0_NAME', 'ccbot'],
      ['CTI_FEISHU_BOTS_0_APP_ID', 'cli_xxx'],
    ]);

    assert.throws(() => parseFeishuBotConfigs(env), /APP_SECRET/i);
  });

  test('returns empty array when no bot keys present', () => {
    const env = new Map<string, string>();
    assert.deepEqual(parseFeishuBotConfigs(env), []);
  });

  test('detects legacy format and throws', () => {
    const env = new Map<string, string>([
      ['CTI_FEISHU_APP_ID', 'cli_old'],
      ['CTI_FEISHU_APP_SECRET', 'secret_old'],
    ]);

    assert.throws(() => parseFeishuBotConfigs(env), /migrate|legacy|旧格式/i);
  });
});
