# Development Guide

This document covers everything you need to integrate Claude-to-IM into your own application: host interface specifications, SSE stream format, step-by-step integration walkthrough, adapter development, and troubleshooting.

## Table of Contents

- [Integration Overview](#integration-overview)
- [Host Interfaces](#host-interfaces)
  - [BridgeStore](#bridgestore)
  - [LLMProvider](#llmprovider)
  - [PermissionGateway](#permissiongateway)
  - [LifecycleHooks](#lifecyclehooks)
- [SSE Stream Format](#sse-stream-format)
- [Step-by-Step Integration](#step-by-step-integration)
- [Developing a New Adapter](#developing-a-new-adapter)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Integration Overview

Claude-to-IM uses dependency injection via a global context. Your application must:

1. Implement four host interfaces (`BridgeStore`, `LLMProvider`, `PermissionGateway`, `LifecycleHooks`)
2. Call `initBridgeContext()` with your implementations before any bridge module is used
3. Call `bridgeManager.start()` to begin polling/listening on IM platforms
4. Configure platform credentials via `BridgeStore.getSetting()`

```
Your Application
    |
    |-- initBridgeContext({ store, llm, permissions, lifecycle })
    |-- bridgeManager.start()
    |
    v
Claude-to-IM (handles IM ↔ LLM message flow automatically)
```

Once started, the bridge runs autonomously: polling adapters for inbound messages, routing them through the conversation engine, and delivering responses back to the IM platform. Your application only needs to provide the persistence and LLM streaming layers.

---

## Host Interfaces

All interfaces are defined in [`src/lib/bridge/host.ts`](../src/lib/bridge/host.ts).

### BridgeStore

The persistence layer. This is the largest interface with ~30 methods organized into categories.

#### Settings

```typescript
getSetting(key: string): string | null;
```

Returns a configuration value by key. All bridge configuration (bot tokens, allowed users, feature flags) is read through this method. Return `null` for unset keys.

**Required keys** (return non-null for these if you want the corresponding adapter to work):

| Key | Example Value | Purpose |
|-----|--------------|---------|
| `remote_bridge_enabled` | `"true"` | Master switch |
| `bridge_telegram_bot_token` | `"123456:ABC..."` | Telegram bot token |
| `bridge_telegram_allowed_users` | `"12345,67890"` | Authorized Telegram user IDs |
| `bridge_telegram_enabled` | `"true"` | Enable Telegram adapter |
| `bridge_discord_bot_token` | `"MTIz..."` | Discord bot token |
| `bridge_discord_allowed_users` | `"111,222"` | Authorized Discord user IDs |
| `bridge_discord_enabled` | `"true"` | Enable Discord adapter |
| `bridge_feishu_app_id` | `"cli_xxx"` | Feishu app ID |
| `bridge_feishu_app_secret` | `"xxx"` | Feishu app secret |
| `bridge_feishu_enabled` | `"true"` | Enable Feishu adapter |
| `bridge_default_cwd` | `"/home/user/projects"` | Default working directory |
| `bridge_model` | `"claude-sonnet-4-20250514"` | Default model |
| `bridge_{adapter}_stream_enabled` | `"true"` | Enable streaming previews |

#### Channel Bindings

```typescript
getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
listChannelBindings(channelType?: ChannelType): ChannelBinding[];
```

Channel bindings map an IM chat (identified by `channelType` + `chatId`) to a session. When a user sends a message from a new chat, the bridge creates a new binding via `upsertChannelBinding()`. Subsequent messages from the same chat reuse the existing binding.

`ChannelBinding` shape:

```typescript
interface ChannelBinding {
  id: string;
  channelType: string;    // 'telegram', 'discord', 'feishu'
  chatId: string;         // Platform-specific chat ID
  codepilotSessionId: string;  // Session ID this chat is bound to
  sdkSessionId: string;   // Claude Code SDK session ID for resume
  workingDirectory: string;
  model: string;
  mode: 'code' | 'plan' | 'ask';
  active: boolean;
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
}
```

#### Sessions

```typescript
getSession(id: string): BridgeSession | null;
createSession(name: string, model: string, systemPrompt?: string, cwd?: string, mode?: string): BridgeSession;
updateSessionProviderId(sessionId: string, providerId: string): void;
```

Sessions represent ongoing conversations. Each channel binding points to a session. `createSession()` should generate a unique ID and store the session.

`BridgeSession` shape:

```typescript
interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}
```

#### Messages

```typescript
addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };
```

Stores conversation history. `role` is typically `"user"` or `"assistant"`. The `usage` parameter (optional) is a JSON string of token usage data.

#### Session Locking

```typescript
acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
releaseSessionLock(sessionId: string, lockId: string): void;
setSessionRuntimeStatus(sessionId: string, status: string): void;
```

The bridge serializes messages within the same session using locks. `acquireSessionLock()` must be atomic: return `true` only if no other lock is held for this session (or the existing lock has expired). For single-process deployments, a simple `Map<string, { lockId, expiry }>` works.

**Lock lifecycle:**
1. Bridge calls `acquireSessionLock(sessionId, lockId, 'bridge', 300)` before processing a message
2. During processing, `renewSessionLock()` extends the TTL every ~60 seconds
3. After processing, `releaseSessionLock()` frees the lock
4. If the process crashes, the TTL ensures the lock auto-expires

#### SDK Session

```typescript
updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
updateSessionModel(sessionId: string, model: string): void;
syncSdkTasks(sessionId: string, todos: unknown): void;
```

These methods track Claude Code SDK-specific state. `sdkSessionId` is needed for session resumption — if the SDK provides a session ID in the stream response, the bridge stores it so subsequent messages can resume the same SDK session.

#### Provider

```typescript
getProvider(id: string): BridgeApiProvider | undefined;
getDefaultProviderId(): string | null;
```

If your application supports multiple API providers (e.g., different API keys or endpoints), implement these to select the provider. The bridge passes the provider to `LLMProvider.streamChat()`. If you only have one provider, return `undefined` from `getProvider()` and `null` from `getDefaultProviderId()`.

#### Audit & Dedup

```typescript
insertAuditLog(entry: AuditLogInput): void;
checkDedup(key: string): boolean;
insertDedup(key: string): void;
cleanupExpiredDedup(): void;
insertOutboundRef(ref: OutboundRefInput): void;
```

- **Audit log**: Every inbound and outbound message is logged. Implement `insertAuditLog()` to store or emit these entries.
- **Dedup**: Prevents duplicate message delivery. `checkDedup(key)` returns `true` if the key was already seen. `insertDedup(key)` records a new key. `cleanupExpiredDedup()` is called periodically to remove old entries (implement a TTL, e.g., 24 hours).
- **Outbound refs**: Tracks which platform messages were sent for which session, used for reference.

#### Permission Links

```typescript
insertPermissionLink(link: PermissionLinkInput): void;
getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
markPermissionLinkResolved(permissionRequestId: string): boolean;
```

When Claude requests permission to use a tool, the bridge sends an interactive message to the IM with inline buttons. A "permission link" maps the permission request ID to the IM message. When the user clicks a button, the bridge looks up the link to verify the callback is legitimate.

`markPermissionLinkResolved()` must be atomic: return `true` only if the link exists and has not been resolved yet, then mark it as resolved. This prevents double-resolution from rapid button clicks.

#### Channel Offsets

```typescript
getChannelOffset(key: string): string;
setChannelOffset(key: string, offset: string): void;
```

Adapters track their polling position using offsets (e.g., Telegram's `update_id`). The bridge persists these so that after a restart, it doesn't re-process old messages. The `key` format is adapter-specific (e.g., `"telegram:bot123456"`).

---

### LLMProvider

```typescript
interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

The single most important interface. It starts a streaming conversation with the LLM and returns a `ReadableStream<string>` of SSE-formatted events.

#### StreamChatParams

```typescript
interface StreamChatParams {
  prompt: string;                    // The user's message text
  sessionId: string;                 // Internal session ID
  sdkSessionId?: string;             // Claude Code SDK session ID for resume
  model?: string;                    // Model to use (e.g., 'claude-sonnet-4-20250514')
  systemPrompt?: string;             // System prompt override
  workingDirectory?: string;         // Working directory for code execution
  abortController?: AbortController; // For cancellation
  permissionMode?: string;           // Permission mode setting
  provider?: BridgeApiProvider;      // API provider configuration
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];          // File attachments from the IM message
  onRuntimeStatusChange?: (status: string) => void;
}
```

#### Implementation Example (Claude Code SDK)

```typescript
import { ClaudeCodeAgent } from '@anthropic-ai/claude-agent-sdk';

class MyLLMProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      async start(controller) {
        const agent = new ClaudeCodeAgent({
          model: params.model,
          workingDirectory: params.workingDirectory,
          // ... other SDK options
        });

        for await (const event of agent.stream(params.prompt)) {
          // Convert SDK events to SSE format
          const sseEvent = { type: event.type, data: JSON.stringify(event.data) };
          controller.enqueue(`data: ${JSON.stringify(sseEvent)}\n`);
        }
        controller.close();
      }
    });
  }
}
```

See the [SSE Stream Format](#sse-stream-format) section for the exact event types the bridge expects.

---

### PermissionGateway

```typescript
interface PermissionGateway {
  resolvePendingPermission(
    permissionRequestId: string,
    resolution: PermissionResolution
  ): boolean;
}
```

When a user clicks "Allow" or "Deny" on a permission prompt in the IM, the bridge calls this method to forward the decision to the LLM session.

```typescript
interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;                  // Reason message (used for deny)
  updatedPermissions?: unknown[];    // Permission updates (used for allow_session)
}
```

If you're using the Claude Code SDK, this maps to the SDK's permission resolution API. The bridge handles all the IM-side UX (inline buttons, callback validation, dedup); your gateway just needs to forward the resolution to the right SDK session.

---

### LifecycleHooks

```typescript
interface LifecycleHooks {
  onBridgeStart?(): void;
  onBridgeStop?(): void;
}
```

Optional callbacks. Useful for updating UI state (e.g., showing a "Bridge Active" indicator) or suppressing other competing polling mechanisms.

---

## SSE Stream Format

The `LLMProvider.streamChat()` must return a `ReadableStream<string>` where each chunk is an SSE line:

```
data: {"type":"<event_type>","data":"<payload>"}\n
```

The bridge parses these events and acts on them:

### Event Types

| Type | Payload (`data` field) | Bridge Behavior |
|------|----------------------|-----------------|
| `text` | The text content (string) | Accumulated into response. Triggers streaming preview if enabled. |
| `tool_use` | JSON: `{"id","name","input"}` | Logged. Not rendered to IM directly. |
| `tool_result` | JSON: `{"tool_use_id","content","is_error"}` | Logged. Not rendered to IM directly. |
| `permission_request` | JSON: `{"id","tool_name","tool_input","suggestions"}` | **Immediately** forwarded to IM as interactive message with Allow/Deny buttons. Stream blocks until resolved. |
| `status` | JSON string containing SDK session info | Captures `sdkSessionId` for session resume. |
| `result` | JSON: `{"usage":{"input_tokens","output_tokens",...},"sdkSessionId",...}` | Final event. Extracts token usage and SDK session ID. |
| `error` | Error message string | Sets `hasError` flag on the conversation result. |
| `keep_alive` | (ignored) | Prevents idle timeout. Bridge ignores this event. |
| `done` | (ignored) | Stream end signal. |

### Example Stream

```
data: {"type":"text","data":"Let me help you with that."}\n
data: {"type":"text","data":" I'll check the file structure first."}\n
data: {"type":"tool_use","data":"{\"id\":\"tool_1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls -la\"}}"}\n
data: {"type":"permission_request","data":"{\"id\":\"perm_1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"},\"suggestions\":[{\"type\":\"allow\",\"toolName\":\"Bash\"}]}"}\n
... (stream blocks until permission is resolved) ...
data: {"type":"tool_result","data":"{\"tool_use_id\":\"tool_1\",\"content\":\"total 42\\ndrwxr-xr-x...\"}"}\n
data: {"type":"text","data":"Here's what I found in the directory..."}\n
data: {"type":"result","data":"{\"usage\":{\"input_tokens\":150,\"output_tokens\":80},\"sdkSessionId\":\"sdk_abc123\"}"}\n
```

### Minimal Implementation (Echo)

For testing or as a starting point:

```typescript
class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}
```

---

## Step-by-Step Integration

### Step 1: Set Up Your Project

```bash
# Clone the library
git clone https://github.com/op7418/Claude-to-IM.git
cd Claude-to-IM
npm install

# Verify everything works
npm run test
```

### Step 2: Implement BridgeStore

Start with the in-memory implementation from [`examples/mock-host.ts`](../src/lib/bridge/examples/mock-host.ts) and replace it with real persistence. Here's a minimal SQLite example structure:

```typescript
import Database from 'better-sqlite3';
import type { BridgeStore, BridgeSession } from './src/lib/bridge/host';
import type { ChannelBinding } from './src/lib/bridge/types';

class SQLiteStore implements BridgeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
        system_prompt TEXT, provider_id TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY, channel_type TEXT, chat_id TEXT,
        session_id TEXT, sdk_session_id TEXT DEFAULT '',
        working_directory TEXT, model TEXT, mode TEXT DEFAULT 'code',
        active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
        UNIQUE(channel_type, chat_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT, role TEXT, content TEXT, usage TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT, chat_id TEXT, direction TEXT,
        message_id TEXT, summary TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS dedup (
        key TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS permission_links (
        permission_request_id TEXT PRIMARY KEY,
        channel_type TEXT, chat_id TEXT, message_id TEXT,
        tool_name TEXT, suggestions TEXT, resolved INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS channel_offsets (
        key TEXT PRIMARY KEY, offset_value TEXT
      );
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id TEXT PRIMARY KEY, lock_id TEXT,
        owner TEXT, expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outbound_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT, chat_id TEXT, session_id TEXT,
        platform_message_id TEXT, purpose TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  getSetting(key: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  // ... implement remaining methods
  // See mock-host.ts for the full method list
}
```

**Key implementation notes:**
- `acquireSessionLock()` must be atomic — use a transaction or `INSERT OR IGNORE` + check
- `markPermissionLinkResolved()` must be atomic — use `UPDATE ... WHERE resolved = 0` and check `changes`
- `cleanupExpiredDedup()` should delete entries older than ~24 hours

### Step 3: Implement LLMProvider

If you're using the Claude Code SDK:

```typescript
import { claude } from '@anthropic-ai/claude-code-sdk';
import type { LLMProvider, StreamChatParams } from './src/lib/bridge/host';

class ClaudeCodeLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      async start(controller) {
        try {
          const conversation = claude.startConversation({
            model: params.model,
            cwd: params.workingDirectory,
            systemPrompt: params.systemPrompt,
            // Resume existing session if available
            ...(params.sdkSessionId ? { sessionId: params.sdkSessionId } : {}),
          });

          for await (const event of conversation.sendMessage(params.prompt, {
            abortSignal: params.abortController?.signal,
          })) {
            // Map SDK events to bridge SSE format
            const sseData = JSON.stringify({ type: event.type, data: JSON.stringify(event) });
            controller.enqueue(`data: ${sseData}\n`);
          }
        } catch (err: any) {
          const errorEvent = JSON.stringify({ type: 'error', data: err.message });
          controller.enqueue(`data: ${errorEvent}\n`);
        } finally {
          controller.close();
        }
      }
    });
  }
}
```

The exact mapping depends on which version of the Claude Code SDK you use. The critical requirement is that `permission_request` events are emitted during the stream (not after), because the stream blocks until the permission is resolved via `PermissionGateway`.

### Step 4: Implement PermissionGateway

```typescript
import type { PermissionGateway, PermissionResolution } from './src/lib/bridge/host';

class MyPermissionGateway implements PermissionGateway {
  // Map of pending permission request IDs to resolve callbacks
  private pending = new Map<string, (resolution: PermissionResolution) => void>();

  // Called by the bridge when a user clicks Allow/Deny in the IM
  resolvePendingPermission(id: string, resolution: PermissionResolution): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    resolve(resolution);
    this.pending.delete(id);
    return true;
  }

  // Called by your LLM provider when a permission request arrives
  registerPending(id: string, resolve: (resolution: PermissionResolution) => void) {
    this.pending.set(id, resolve);
  }
}
```

### Step 5: Initialize and Start

```typescript
import { initBridgeContext } from './src/lib/bridge/context';
import * as bridgeManager from './src/lib/bridge/bridge-manager';

// Initialize
const store = new SQLiteStore('./bridge.db');
const llm = new ClaudeCodeLLM();
const permissions = new MyPermissionGateway();

initBridgeContext({
  store,
  llm,
  permissions,
  lifecycle: {
    onBridgeStart: () => console.log('Bridge started'),
    onBridgeStop: () => console.log('Bridge stopped'),
  },
});

// Configure settings (in your DB or settings UI)
// store.setSetting('remote_bridge_enabled', 'true');
// store.setSetting('bridge_telegram_enabled', 'true');
// store.setSetting('bridge_telegram_bot_token', 'YOUR_BOT_TOKEN');
// store.setSetting('bridge_telegram_allowed_users', 'YOUR_USER_ID');

// Start the bridge
await bridgeManager.start();
console.log('Bridge status:', bridgeManager.getStatus());
```

### Step 6: Verify

1. Send a message to your Telegram/Discord/Feishu bot
2. Check that the bridge routes it through `channel-router` -> `conversation-engine` -> `delivery-layer`
3. Verify the response appears in the IM
4. Test permission flows: trigger a tool use that requires approval, check that inline buttons appear

---

## Developing a New Adapter

To add support for a new IM platform (e.g., Slack, WhatsApp, LINE):

### Step 1: Create the Adapter File

```typescript
// src/lib/bridge/adapters/my-platform-adapter.ts

import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getBridgeContext } from '../context';
import type { InboundMessage, OutboundMessage, SendResult } from '../types';

class MyPlatformAdapter extends BaseChannelAdapter {
  readonly channelType = 'my-platform';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiter: ((msg: InboundMessage | null) => void) | null = null;

  async start() {
    if (this.running) return;
    const { store } = getBridgeContext();
    const token = store.getSetting('bridge_my_platform_bot_token');
    if (!token) throw new Error('Missing bot token');

    this.running = true;
    // Start your platform's connection (WebSocket, long polling, webhook, etc.)
    this.startListening(token);
  }

  async stop() {
    this.running = false;
    // Clean up connections
    if (this.waiter) {
      this.waiter(null);
      this.waiter = null;
    }
  }

  isRunning() { return this.running; }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise(resolve => { this.waiter = resolve; });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    // Call your platform's API to send the message
    try {
      const result = await this.platformApi.sendMessage(message.address.chatId, message.text);
      return { ok: true, messageId: result.id };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    if (!store.getSetting('bridge_my_platform_bot_token')) {
      return 'Missing bridge_my_platform_bot_token';
    }
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const { store } = getBridgeContext();
    const allowed = store.getSetting('bridge_my_platform_allowed_users');
    if (!allowed) return false;
    return allowed.split(',').map(s => s.trim()).includes(userId);
  }

  private startListening(token: string) {
    // Platform-specific: convert incoming events to InboundMessage and enqueue
  }

  private enqueue(msg: InboundMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }
}

// Self-register — this runs when the module is imported
registerAdapterFactory('my-platform', () => new MyPlatformAdapter());
```

### Step 2: Register the Adapter

Add the import to `src/lib/bridge/adapters/index.ts`:

```typescript
import './telegram-adapter';
import './discord-adapter';
import './feishu-adapter';
import './my-platform-adapter';  // Add this line
```

### Step 3: Add Platform Limit

In `src/lib/bridge/types.ts`, add your platform's message length limit:

```typescript
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  'my-platform': 4000,  // Add this
};
```

### Step 4: Add Markdown Rendering (Optional)

If your platform has specific formatting requirements, create a renderer in `src/lib/bridge/markdown/`. Otherwise, the bridge falls back to plain text delivery.

For platform-specific rendering, add a case in `bridge-manager.ts`'s `deliverResponse()` method.

### Step 5: Test

Create `src/__tests__/unit/bridge-my-platform-adapter.test.ts` following the pattern of existing adapter tests.

---

## Testing

### Running Tests

```bash
npm run test:unit    # Run all bridge unit tests
npm run typecheck    # TypeScript type checking
npm run test         # Both of the above
```

### Writing Tests

Tests use Node.js built-in test runner (`node:test`). Each test file:

1. Creates mock implementations of host interfaces
2. Initializes the bridge context with `initBridgeContext()`
3. Cleans up `globalThis['__bridge_context__']` in `beforeEach`

Example pattern:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore } from '../../lib/bridge/host';

function createMockStore() {
  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    // ... implement all BridgeStore methods with test defaults
  };
}

describe('my-module', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    const store = createMockStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  it('does something', () => {
    // Your test logic
  });
});
```

See existing test files in `src/__tests__/unit/` for complete mock store implementations.

---

## Troubleshooting

### "Context not initialized" Error

```
Error: [bridge] Context not initialized. Call initBridgeContext() before using bridge modules.
```

You must call `initBridgeContext()` before importing or using any bridge module that calls `getBridgeContext()`. Make sure the initialization happens early in your application startup.

### Adapter Doesn't Start

Check:
1. `remote_bridge_enabled` returns `"true"` from `getSetting()`
2. `bridge_{adapter}_enabled` returns `"true"`
3. The bot token setting is set and valid
4. `validateConfig()` returns `null` (no errors)

### Permission Buttons Don't Work

1. Verify `insertPermissionLink()` is storing the link correctly
2. Verify `getPermissionLink()` returns the stored link by `permissionRequestId`
3. Verify `markPermissionLinkResolved()` is atomic — returns `true` only once per link
4. Check that callback messages have the correct `callbackData` format: `perm:allow:{id}` or `perm:deny:{id}`

### Messages Are Duplicated

1. Check that `checkDedup()` and `insertDedup()` are working correctly
2. Verify `cleanupExpiredDedup()` isn't deleting entries too aggressively (keep at least 24 hours)
3. For Telegram: verify channel offsets are persisted — `getChannelOffset()` / `setChannelOffset()` must survive restarts

### Streaming Previews Not Showing

1. Verify `bridge_{adapter}_stream_enabled` returns `"true"`
2. Check that your `LLMProvider` emits `text` events incrementally (not all at once at the end)
3. Telegram: previews only work in private chats by default
4. Discord: check that the bot has permission to edit its own messages

### Process Hangs After Tests

The `delivery-layer.ts` module has a `setInterval` for rate limiter cleanup that keeps Node.js alive. Use `--test-timeout` flag:

```bash
node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-*.test.ts
```

### TypeScript Errors

Make sure your `tsconfig.json` includes `"lib": ["ESNext"]` — the code uses `Array.prototype.toSorted()` which requires ES2023+.
