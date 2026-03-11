# Claude-to-IM

English | [中文](README.zh-CN.md)

Claude-to-IM is a host-agnostic bridge library that connects [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) to IM platforms, allowing users to interact with Claude through Telegram, Discord, Feishu (Lark), and DingTalk.

This library handles all IM-side complexity — message routing, streaming previews, permission approval flows, Markdown rendering, chunking, retry, rate limiting — while delegating persistence, LLM calls, and permission resolution to the host application through a set of dependency injection interfaces.

## Out-of-the-Box Solution

If you want a ready-to-use desktop application without writing any integration code, check out [CodePilot](https://github.com/op7418/CodePilot) — a desktop GUI client for Claude Code with built-in IM bridge support. CodePilot implements all the host interfaces for you and provides a complete UI for managing sessions, settings, and bridge connections.

Claude-to-IM was extracted from CodePilot as a standalone library for developers who want to embed the IM bridge capability in their own applications.

## Features

- **Multi-platform adapters**: Telegram (long polling), Discord (Gateway WebSocket), Feishu/Lark (WSClient), DingTalk (Stream Mode WebSocket)
- **Streaming previews**: Real-time response drafts via message editing, with per-platform throttling
- **Permission management**: Interactive inline buttons for Claude Code tool approvals (allow / deny / allow for session)
- **Session binding**: Each IM chat maps to a persistent conversation session with working directory and model settings
- **Markdown rendering**: Platform-native formatting — HTML for Telegram, Discord-flavored Markdown, Feishu rich text cards, DingTalk markdown replies
- **Reliable delivery**: Auto-chunking at platform limits, retry with exponential backoff, HTML fallback on parse errors, message deduplication
- **Security**: Input validation, token bucket rate limiting (20 msg/min per chat), user authorization whitelists, full audit logging
- **Host-agnostic**: All host dependencies abstracted via 4 DI interfaces — no database driver, no LLM client, no framework lock-in

## Architecture

```
IM Platform (Telegram / Discord / Feishu / DingTalk)
        |
        | InboundMessage
        v
   +-----------+     +------------------+
   |  Adapter   |---->| Bridge Manager   |  (orchestrator)
   +-----------+     |  |- Channel Router     -> session binding
                     |  |- Conversation Engine -> LLM streaming
                     |  |- Permission Broker   -> tool approval flow
                     |  |- Delivery Layer      -> chunking, retry, dedup
                     +------------------+
                            |
                            | Host Interfaces (DI)
                            v
                     +------------------+
                     | Host Application |  (implements BridgeStore,
                     |                  |   LLMProvider, etc.)
                     +------------------+
```

All bridge modules access host services through a DI context (`getBridgeContext()`), never through direct imports. This means you can plug the bridge into any Node.js application by implementing four interfaces.

## Quick Start

### 1. Install

```bash
npm install claude-to-im
```

Or clone this repo and install dependencies:

```bash
git clone https://github.com/op7418/Claude-to-IM.git
cd Claude-to-IM
npm install
```

### 2. Implement Host Interfaces

The bridge requires four interfaces. See [`docs/development.md`](docs/development.md) for the full specification of each interface.

```typescript
import { initBridgeContext } from 'claude-to-im/context';
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from 'claude-to-im/host';

const store: BridgeStore = { /* your persistence layer (~30 methods) */ };
const llm: LLMProvider = { /* wraps Claude Code SDK streamChat */ };
const permissions: PermissionGateway = { /* resolves pending tool permissions */ };
const lifecycle: LifecycleHooks = { /* optional start/stop callbacks */ };

initBridgeContext({ store, llm, permissions, lifecycle });
```

### 3. Start the Bridge

```typescript
import * as bridgeManager from 'claude-to-im/bridge-manager';

await bridgeManager.start();

const status = bridgeManager.getStatus();
// { running: true, adapters: [{ channelType: 'telegram', running: true, ... }] }
```

### 4. Run the Example

A self-contained example with in-memory store and echo LLM is included:

```bash
npx tsx src/lib/bridge/examples/mock-host.ts
```

To test the DingTalk Stream demo:

```bash
DINGTALK_CLIENT_ID=dingxxxx \
DINGTALK_CLIENT_SECRET=xxxx \
DINGTALK_ALLOWED_USERS="*" \
npm run example:dingtalk
```

Set `DINGTALK_DEBUG=true` if you want inbound / outbound adapter logs in the console.

## Configuration

All settings are read through `BridgeStore.getSetting(key)`. Your host application decides how to store and surface these values (database, env vars, config file, UI settings panel, etc.).

### Required Settings

| Key | Description |
|-----|-------------|
| `remote_bridge_enabled` | Master switch — `"true"` to enable the bridge |
| `bridge_{adapter}_allowed_users` | Comma-separated user IDs authorized to use the bridge |

Platform-specific credentials:

- `bridge_telegram_bot_token`
- `bridge_discord_bot_token`
- `bridge_feishu_app_id` + `bridge_feishu_app_secret`
- `bridge_dingtalk_client_id` + `bridge_dingtalk_client_secret`

### Optional Settings

| Key | Description | Default |
|-----|-------------|---------|
| `bridge_auto_start` | Auto-start bridge on app launch | `"false"` |
| `bridge_{adapter}_enabled` | Per-adapter toggle | `"false"` |
| `bridge_{adapter}_stream_enabled` | Enable streaming previews | `"true"` |
| `bridge_default_cwd` | Default working directory for new sessions | `$HOME` |
| `bridge_model` | Default Claude model | Host decides |

Replace `{adapter}` with `telegram`, `discord`, `feishu`, or `dingtalk`.

## Limitations

Before adopting this library, be aware of the following constraints:

### You Must Implement the Host Interfaces

This is a library, not a standalone application. You need to provide:

- **`BridgeStore`** — A persistence layer with ~30 methods covering settings, sessions, messages, channel bindings, audit logs, dedup tracking, permission links, and channel offsets. This is the largest integration surface. See the full interface definition in [`src/lib/bridge/host.ts`](src/lib/bridge/host.ts).
- **`LLMProvider`** — A wrapper around your LLM client that returns a `ReadableStream<string>` of SSE-formatted events. The stream format must match the Claude Code SDK's event protocol (text, tool_use, tool_result, permission_request, status, result events). See [`docs/development.md`](docs/development.md) for the full event format spec.
- **`PermissionGateway`** — A way to resolve pending tool permissions from the Claude Code SDK.
- **`LifecycleHooks`** — Optional callbacks for bridge start/stop events.

### LLM Stream Format

The `LLMProvider.streamChat()` must return SSE-formatted strings matching the Claude Code SDK's event protocol. If you are not using the Claude Code SDK, you need to adapt your LLM client's output to match this format. This is not a generic "chat completion" interface.

### No Built-in Persistence

The bridge does not bundle any database driver. You provide all persistence through `BridgeStore`. This gives you full control but means you need to implement storage for sessions, messages, bindings, audit logs, dedup keys, permission links, and channel offsets.

### Session Locking

The bridge uses a session lock mechanism (`acquireSessionLock` / `renewSessionLock` / `releaseSessionLock`) to serialize messages within the same session. Your `BridgeStore` implementation must provide atomic lock operations. For single-process deployments, in-memory locks work fine. For multi-process deployments, you need distributed locking (e.g., database-backed).

### Platform Bot Setup

You still need to create bots on each platform and obtain tokens:
- **Telegram**: Create a bot via [@BotFather](https://t.me/BotFather)
- **Discord**: Create an application in the [Developer Portal](https://discord.com/developers/applications) with Message Content Intent enabled
- **Feishu**: Create an app in the [Developer Console](https://open.feishu.cn/app) with IM permissions
- **DingTalk**: Create an internal app in the [DingTalk Developer Console](https://open.dingtalk.com/), enable the bot capability, and use Stream Mode with `bridge_dingtalk_client_id` / `bridge_dingtalk_client_secret`

## Documentation

| Document | Description |
|----------|-------------|
| [Development Guide](docs/development.md) | Host interface specs, SSE format, adapter development, step-by-step integration tutorial |
| [Architecture](src/lib/bridge/ARCHITECTURE.md) | Module dependency graph, message flows, design decisions |
| [Security](src/lib/bridge/SECURITY.md) | Threat model, mitigations, deployment recommendations |
| [Contributing](src/lib/bridge/CONTRIBUTING.md) | Dev setup, code style, testing guide |
| [Migration](src/lib/bridge/MIGRATION.md) | Before/after import patterns for migrating from direct imports |

## Project Structure

```
src/
  lib/bridge/
    context.ts              # DI container (initBridgeContext / getBridgeContext)
    host.ts                 # Host interface definitions (BridgeStore, LLMProvider, etc.)
    types.ts                # Shared type definitions (messages, bindings, status)
    bridge-manager.ts       # Orchestrator — start/stop, message dispatch, session locks
    channel-adapter.ts      # Abstract base class + adapter registry
    channel-router.ts       # ChannelAddress -> ChannelBinding resolution
    conversation-engine.ts  # LLM stream processing, SSE consumption
    delivery-layer.ts       # Reliable outbound delivery (chunk, retry, dedup, audit)
    permission-broker.ts    # Tool permission forwarding and callback handling
    adapters/
      telegram-adapter.ts   # Telegram Bot API long polling
      discord-adapter.ts    # Discord.js Gateway WebSocket
      feishu-adapter.ts     # Feishu/Lark WSClient
      dingtalk-adapter.ts   # DingTalk Stream Mode WebSocket
      telegram-media.ts     # Telegram file download/attachment handling
      telegram-utils.ts     # Telegram API helpers
      index.ts              # Side-effect imports for adapter self-registration
    markdown/
      ir.ts                 # Intermediate representation for Markdown AST
      render.ts             # Generic IR -> platform string renderer
      telegram.ts           # Markdown -> Telegram HTML
      discord.ts            # Markdown -> Discord-flavored Markdown
      feishu.ts             # Markdown -> Feishu rich text / cards
      dingtalk.ts           # Markdown normalization for DingTalk
    security/
      validators.ts         # Input validation (path traversal, injection, sanitization)
      rate-limiter.ts       # Token bucket rate limiter (per chat)
    examples/
      mock-host.ts          # Runnable example with InMemoryStore + EchoLLM
      dingtalk-stream-demo.ts # Runnable DingTalk Stream demo
      example-support.ts    # Shared InMemoryStore / EchoLLM helpers for examples
  __tests__/unit/
    bridge-channel-router.test.ts
    bridge-delivery-layer.test.ts
    bridge-manager.test.ts
    bridge-permission-broker.test.ts
```

## Testing

```bash
# Type checking
npm run typecheck

# Unit tests (28 tests)
npm run test:unit

# Both
npm run test
```

Tests use Node.js built-in test runner (`node:test`) with mock implementations of all host interfaces — no real database or LLM required.

## License

MIT
