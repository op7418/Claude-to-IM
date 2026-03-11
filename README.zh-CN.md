# Claude-to-IM

[English](README.md) | 中文

Claude-to-IM 是一个与宿主应用解耦的桥接库，用于将 [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) 连接到 IM 平台，让用户可以通过 Telegram、Discord、飞书和钉钉直接与 Claude 交互。

这个库处理了 IM 侧的所有复杂性——消息路由、流式预览、权限审批流程、Markdown 渲染、消息分块、重试、速率限制——同时通过一组依赖注入接口将持久化、LLM 调用和权限解析委托给宿主应用。

## 开箱即用方案

如果你想要一个无需编写集成代码就能直接使用的桌面应用，请查看 [CodePilot](https://github.com/op7418/CodePilot)——一个带有内置 IM 桥接支持的 Claude Code 桌面 GUI 客户端。CodePilot 已经实现了所有的宿主接口，并提供完整的会话管理、设置和桥接连接的 UI 界面。

Claude-to-IM 从 CodePilot 中提取出来作为独立库，供需要在自己的应用中嵌入 IM 桥接能力的开发者使用。

## 功能特性

- **多平台适配器**：Telegram（长轮询）、Discord（Gateway WebSocket）、飞书（WSClient）、钉钉（Stream Mode WebSocket）
- **流式预览**：通过消息编辑实现实时响应草稿，支持按平台定制的节流策略
- **权限管理**：通过交互式内联按钮实现 Claude Code 工具审批（允许 / 拒绝 / 本次会话允许）
- **会话绑定**：每个 IM 聊天映射到一个持久化的会话，支持工作目录和模型配置
- **Markdown 渲染**：平台原生格式化——Telegram 用 HTML、Discord 用 Discord 风格 Markdown、飞书用富文本卡片、钉钉用 Markdown 回复
- **可靠投递**：按平台限制自动分块、指数退避重试、HTML 降级、消息去重
- **安全机制**：输入验证、令牌桶速率限制（每个聊天 20 条/分钟）、用户授权白名单、完整审计日志
- **宿主无关**：所有宿主依赖通过 4 个 DI 接口抽象——不绑定数据库驱动、不绑定 LLM 客户端、不绑定框架

## 架构

```
IM 平台 (Telegram / Discord / 飞书 / 钉钉)
        |
        | InboundMessage（入站消息）
        v
   +-----------+     +------------------+
   |  Adapter   |---->| Bridge Manager   |  （编排器）
   |  适配器     |     |  |- Channel Router     -> 会话绑定
   +-----------+     |  |- Conversation Engine -> LLM 流式调用
                     |  |- Permission Broker   -> 工具审批流程
                     |  |- Delivery Layer      -> 分块、重试、去重
                     +------------------+
                            |
                            | Host Interfaces（宿主接口，DI）
                            v
                     +------------------+
                     | Host Application |  （实现 BridgeStore、
                     | 宿主应用         |   LLMProvider 等）
                     +------------------+
```

所有桥接模块通过 DI 上下文（`getBridgeContext()`）访问宿主服务，不直接导入宿主模块。这意味着你只需实现四个接口，就可以将桥接功能接入任何 Node.js 应用。

## 快速开始

### 1. 安装

```bash
npm install claude-to-im
```

或者克隆仓库并安装依赖：

```bash
git clone https://github.com/op7418/Claude-to-IM.git
cd Claude-to-IM
npm install
```

### 2. 实现宿主接口

桥接系统需要四个接口。完整的接口规范见 [`docs/development.zh-CN.md`](docs/development.zh-CN.md)。

```typescript
import { initBridgeContext } from 'claude-to-im/context';
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from 'claude-to-im/host';

const store: BridgeStore = { /* 你的持久化层（约 30 个方法） */ };
const llm: LLMProvider = { /* 包装 Claude Code SDK 的 streamChat */ };
const permissions: PermissionGateway = { /* 解析待处理的工具权限 */ };
const lifecycle: LifecycleHooks = { /* 可选的启动/停止回调 */ };

initBridgeContext({ store, llm, permissions, lifecycle });
```

### 3. 启动桥接

```typescript
import * as bridgeManager from 'claude-to-im/bridge-manager';

await bridgeManager.start();

const status = bridgeManager.getStatus();
// { running: true, adapters: [{ channelType: 'telegram', running: true, ... }] }
```

### 4. 运行示例

项目包含一个自包含的示例，使用内存存储和 Echo LLM：

```bash
npx tsx src/lib/bridge/examples/mock-host.ts
```

测试钉钉 Stream demo：

```bash
DINGTALK_CLIENT_ID=dingxxxx \
DINGTALK_CLIENT_SECRET=xxxx \
DINGTALK_ALLOWED_USERS="*" \
npm run example:dingtalk
```

如果你想在控制台查看钉钉适配器的收发日志，可以额外设置 `DINGTALK_DEBUG=true`。

## 配置

所有设置通过 `BridgeStore.getSetting(key)` 读取。你的宿主应用决定如何存储和暴露这些值（数据库、环境变量、配置文件、UI 设置面板等）。

### 必需配置

| Key | 说明 |
|-----|------|
| `remote_bridge_enabled` | 总开关——设为 `"true"` 启用桥接 |
| `bridge_{adapter}_allowed_users` | 逗号分隔的授权用户 ID |

平台专属凭据：

- `bridge_telegram_bot_token`
- `bridge_discord_bot_token`
- `bridge_feishu_app_id` + `bridge_feishu_app_secret`
- `bridge_dingtalk_client_id` + `bridge_dingtalk_client_secret`

### 可选配置

| Key | 说明 | 默认值 |
|-----|------|--------|
| `bridge_auto_start` | 应用启动时自动启动桥接 | `"false"` |
| `bridge_{adapter}_enabled` | 按适配器的开关 | `"false"` |
| `bridge_{adapter}_stream_enabled` | 启用流式预览 | `"true"` |
| `bridge_default_cwd` | 新会话的默认工作目录 | `$HOME` |
| `bridge_model` | 默认 Claude 模型 | 由宿主决定 |

将 `{adapter}` 替换为 `telegram`、`discord`、`feishu` 或 `dingtalk`。

## 局限性

在采用这个库之前，请注意以下限制：

### 必须自行实现宿主接口

这是一个库，不是独立应用。你需要提供：

- **`BridgeStore`**——一个包含约 30 个方法的持久化层，涵盖设置、会话、消息、通道绑定、审计日志、去重跟踪、权限链接和通道偏移量。这是最大的集成面。完整的接口定义见 [`src/lib/bridge/host.ts`](src/lib/bridge/host.ts)。
- **`LLMProvider`**——一个 LLM 客户端包装器，返回 `ReadableStream<string>` 格式的 SSE 事件流。流的格式必须匹配 Claude Code SDK 的事件协议（text、tool_use、tool_result、permission_request、status、result 事件）。完整的事件格式规范见 [`docs/development.zh-CN.md`](docs/development.zh-CN.md)。
- **`PermissionGateway`**——用于解析来自 Claude Code SDK 的待处理工具权限。
- **`LifecycleHooks`**——可选的桥接启动/停止事件回调。

### LLM 流格式

`LLMProvider.streamChat()` 必须返回与 Claude Code SDK 事件协议匹配的 SSE 格式字符串。如果你没有使用 Claude Code SDK，需要将你的 LLM 客户端输出适配为这种格式。这不是一个通用的"聊天补全"接口。

### 不内置持久化

桥接不打包任何数据库驱动。所有持久化通过 `BridgeStore` 提供。这给你完全的控制权，但意味着你需要自行实现会话、消息、绑定、审计日志、去重键、权限链接和通道偏移量的存储。

### 会话锁

桥接使用会话锁机制（`acquireSessionLock` / `renewSessionLock` / `releaseSessionLock`）来串行化同一会话内的消息。你的 `BridgeStore` 实现必须提供原子锁操作。单进程部署可以使用内存锁。多进程部署需要分布式锁（如基于数据库的锁）。

### 平台 Bot 设置

你仍然需要在各平台上创建 Bot 并获取 Token：
- **Telegram**：通过 [@BotFather](https://t.me/BotFather) 创建 Bot
- **Discord**：在 [Developer Portal](https://discord.com/developers/applications) 创建应用，启用 Message Content Intent
- **飞书**：在[开发者后台](https://open.feishu.cn/app)创建应用，配置 IM 权限
- **钉钉**：在[钉钉开放平台](https://open.dingtalk.com/)创建企业内部应用，启用机器人能力并使用 Stream 模式，配置 `bridge_dingtalk_client_id` / `bridge_dingtalk_client_secret`

## 文档

| 文档 | 说明 |
|------|------|
| [开发指南](docs/development.zh-CN.md) | 宿主接口规范、SSE 格式、适配器开发、分步集成教程 |
| [架构](src/lib/bridge/ARCHITECTURE.md) | 模块依赖图、消息流、设计决策 |
| [安全](src/lib/bridge/SECURITY.md) | 威胁模型、缓解措施、部署建议 |
| [贡献指南](src/lib/bridge/CONTRIBUTING.md) | 开发环境、代码风格、测试指南 |
| [迁移](src/lib/bridge/MIGRATION.md) | 从直接导入迁移到 DI 的前后对比 |

## 项目结构

```
src/
  lib/bridge/
    context.ts              # DI 容器 (initBridgeContext / getBridgeContext)
    host.ts                 # 宿主接口定义 (BridgeStore, LLMProvider 等)
    types.ts                # 共享类型定义 (消息、绑定、状态)
    bridge-manager.ts       # 编排器——启停、消息分发、会话锁
    channel-adapter.ts      # 抽象基类 + 适配器注册表
    channel-router.ts       # ChannelAddress -> ChannelBinding 解析
    conversation-engine.ts  # LLM 流处理、SSE 消费
    delivery-layer.ts       # 可靠的出站投递（分块、重试、去重、审计）
    permission-broker.ts    # 工具权限转发和回调处理
    adapters/
      telegram-adapter.ts   # Telegram Bot API 长轮询
      discord-adapter.ts    # Discord.js Gateway WebSocket
      feishu-adapter.ts     # 飞书 WSClient
      dingtalk-adapter.ts   # 钉钉 Stream Mode WebSocket
      telegram-media.ts     # Telegram 文件下载/附件处理
      telegram-utils.ts     # Telegram API 辅助函数
      index.ts              # 副作用导入，用于适配器自注册
    markdown/
      ir.ts                 # Markdown AST 中间表示
      render.ts             # 通用 IR -> 平台字符串渲染器
      telegram.ts           # Markdown -> Telegram HTML
      discord.ts            # Markdown -> Discord 风格 Markdown
      feishu.ts             # Markdown -> 飞书富文本/卡片
      dingtalk.ts           # 钉钉 Markdown 规范化
    security/
      validators.ts         # 输入验证（路径穿越、注入、消毒）
      rate-limiter.ts       # 令牌桶速率限制器（按聊天）
    examples/
      mock-host.ts          # 可运行示例，含 InMemoryStore + EchoLLM
      dingtalk-stream-demo.ts # 可运行的钉钉 Stream demo
      example-support.ts    # 示例共用的 InMemoryStore / EchoLLM 辅助
  __tests__/unit/
    bridge-channel-router.test.ts
    bridge-delivery-layer.test.ts
    bridge-manager.test.ts
    bridge-permission-broker.test.ts
```

## 测试

```bash
# 类型检查
npm run typecheck

# 单元测试（28 个测试）
npm run test:unit

# 全部
npm run test
```

测试使用 Node.js 内置测试运行器（`node:test`），配合所有宿主接口的 mock 实现——不需要真实数据库或 LLM。

## License

MIT
