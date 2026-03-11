/**
 * DingTalk Stream Demo
 *
 * Usage:
 *   DINGTALK_CLIENT_ID=dingxxxx \
 *   DINGTALK_CLIENT_SECRET=xxxx \
 *   DINGTALK_ALLOWED_USERS=user123,user456 \
 *   npm run example:dingtalk
 *
 * Optional env:
 *   DINGTALK_GROUP_POLICY=open|disabled|allowlist   (default: open)
 *   DINGTALK_GROUP_ALLOW_FROM=cidxxx,cidyyy
 *   DINGTALK_REQUIRE_MENTION=true|false             (default: true)
 *   DINGTALK_DEBUG=true|false                       (default: false)
 *   BRIDGE_DEFAULT_CWD=/abs/path                    (default: process.cwd())
 *   BRIDGE_MODEL=claude-sonnet-4-20250514           (default: local Claude default)
 */

import { initBridgeContext } from '../context.js';
import * as bridgeManager from '../bridge-manager.js';
import {
  ClaudeCodeLLM,
  InMemoryStore,
  InteractivePermissionGateway,
  logLifecycle,
} from './example-support.js';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildSettings(): Record<string, string> {
  const configuredModel = process.env.BRIDGE_MODEL?.trim() || '';
  const configuredCwd = process.env.BRIDGE_DEFAULT_CWD?.trim() || process.cwd();
  const settings: Record<string, string> = {
    remote_bridge_enabled: 'true',
    bridge_dingtalk_enabled: 'true',
    bridge_dingtalk_client_id: requireEnv('DINGTALK_CLIENT_ID'),
    bridge_dingtalk_client_secret: requireEnv('DINGTALK_CLIENT_SECRET'),
    bridge_dingtalk_allowed_users: process.env.DINGTALK_ALLOWED_USERS?.trim() || '',
    bridge_dingtalk_group_policy: process.env.DINGTALK_GROUP_POLICY?.trim() || 'open',
    bridge_dingtalk_group_allow_from: process.env.DINGTALK_GROUP_ALLOW_FROM?.trim() || '',
    bridge_dingtalk_require_mention: process.env.DINGTALK_REQUIRE_MENTION?.trim() || 'true',
    bridge_dingtalk_debug: process.env.DINGTALK_DEBUG?.trim() || 'false',
    bridge_default_cwd: configuredCwd,
    bridge_default_work_dir: configuredCwd,
    bridge_default_model: configuredModel,
    default_model: configuredModel,
  };

  return settings;
}

async function main() {
  const settings = buildSettings();
  const store = new InMemoryStore(settings);
  const permissions = new InteractivePermissionGateway(settings.bridge_dingtalk_debug === 'true');

  initBridgeContext({
    store,
    llm: new ClaudeCodeLLM({
      debug: settings.bridge_dingtalk_debug === 'true',
      permissions,
    }),
    permissions,
    lifecycle: logLifecycle,
  });

  console.log('=== Claude-to-IM DingTalk Stream Demo ===');
  console.log('Provider: local Claude Code');
  console.log(`Client ID: ${settings.bridge_dingtalk_client_id}`);
  console.log(`Allowed Users: ${settings.bridge_dingtalk_allowed_users || '(all users)'}`);
  console.log(`Group Policy: ${settings.bridge_dingtalk_group_policy}`);
  console.log(`Require Mention: ${settings.bridge_dingtalk_require_mention}`);
  console.log(`Model: ${settings.bridge_default_model || '(Claude default)'}`);
  console.log(`Working Directory: ${settings.bridge_default_work_dir}`);
  console.log('');

  await bridgeManager.start();

  const status = bridgeManager.getStatus();
  console.log('Bridge status:', JSON.stringify(status, null, 2));
  console.log('');
  console.log('Demo is running. Send a message to the DingTalk bot to receive a Claude response.');
  console.log('Tool permission requests require a chat reply: 1=allow once, 2=allow session, 3=deny.');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, stopping bridge...`);
    await bridgeManager.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  try {
    await bridgeManager.stop();
  } catch {
    // Ignore cleanup errors in the demo path
  }
  process.exit(1);
});
