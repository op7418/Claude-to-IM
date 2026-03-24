/**
 * Minimal Mock Host Example
 *
 * Demonstrates how to wire up Claude-to-IM with mock implementations
 * of all host interfaces. This runs the full bridge pipeline without
 * any real database, LLM, or permission system.
 *
 * Usage:
 *   npx tsx src/lib/bridge/examples/mock-host.ts
 *
 * This example:
 * 1. Creates an in-memory store
 * 2. Creates a mock LLM that echoes back messages
 * 3. Initializes the bridge context
 * 4. Simulates processing a message through the pipeline
 */

import { initBridgeContext } from '../context.js';
import * as router from '../channel-router.js';
import * as engine from '../conversation-engine.js';
import { EchoLLM, InMemoryStore, allowAllPermissions, logLifecycle } from './example-support.js';

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Claude-to-IM Mock Host Example ===\n');

  // 1. Initialize context
  initBridgeContext({
    store: new InMemoryStore(),
    llm: new EchoLLM(),
    permissions: allowAllPermissions,
    lifecycle: logLifecycle,
  });

  // 2. Simulate an inbound message
  const address = { channelType: 'telegram', chatId: '12345', displayName: 'Test User' };

  console.log('Resolving channel binding...');
  const binding = router.resolve(address);
  console.log(`  Session: ${binding.codepilotSessionId}`);
  console.log(`  CWD: ${binding.workingDirectory}\n`);

  // 3. Process message through conversation engine
  console.log('Processing message: "Hello, Claude!"');
  const result = await engine.processMessage(binding, 'Hello, Claude!');

  console.log(`\nResult:`);
  console.log(`  Response: "${result.responseText}"`);
  console.log(`  Has error: ${result.hasError}`);
  console.log(`  Token usage: ${JSON.stringify(result.tokenUsage)}`);

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
