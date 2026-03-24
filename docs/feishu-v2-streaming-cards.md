# 飞书 V2 — 流式卡片 + 权限按钮

> 状态：**待开始**
> 目标：将 CodePilot 飞书 V2 的核心能力移植到 claude-to-im 开源库

## 背景

CodePilot 已实现飞书 V2：CardKit v2 流式卡片、工具进度、权限内联按钮、Thinking 状态、Footer 耗时。
claude-to-im 当前飞书实现：无流式（发最终结果）、权限靠文本命令 `/perm`、无工具进度显示。

## 目标能力

| 能力 | 说明 |
|------|------|
| 流式卡片 | CardKit v2 create → streamContent → finalize，实时显示生成过程 |
| 工具进度 | 🔄 Running / ✅ Complete / ❌ Error 实时渲染 |
| 权限按钮 | card.action.trigger 内联按钮替代文本命令 |
| Thinking 状态 | 文本到达前显示 💭 Thinking... |
| Footer | 状态指示 + 耗时 |

## 架构决策

### D1: CardKit v2 REST API vs im.message.patch

**选择：CardKit v2 REST API**

理由：
- `im.message.patch` 有频率限制且不支持真正的流式模式
- CardKit v2 提供 `streaming_mode`、`streamContent`、`setStreamingMode` 原生流式 API
- 与 CodePilot 方案一致，已验证可行

API 调用序列：
1. `POST /cardkit/v2/cards` — 创建卡片（streaming_mode: true）
2. `POST /im/v1/messages` — 发送卡片消息（content: `{type:"card", data:{card_id}}` ）
3. `PATCH /cardkit/v2/cards/{card_id}/elements/{element_id}` 或 `streamContent` — 更新内容
4. `PUT /cardkit/v2/cards/{card_id}/settings/streaming_mode` — 关闭流式
5. `PUT /cardkit/v2/cards/{card_id}` — 最终更新（footer、工具进度定稿）

### D2: card.action.trigger 接收方式

**选择：WSClient monkey-patch**

理由：
- WSClient 只处理 `type="event"` 的消息，`type="card"` 会被丢弃
- 无需 HTTP 公网端点（daemon 场景没有公网 IP）
- 已在 CodePilot 验证可行

实现：monkey-patch `wsClient.handleEventData`，将 `type="card"` 改写为 `type="event"` 后交给 EventDispatcher。

### D3: 工具事件传递路径

**选择：扩展 conversation-engine 回调**

理由：
- 当前 `consumeStream` 已解析 `tool_use` / `tool_result` 事件但不回调
- 新增 `onToolEvent` 回调，与 `onPartialText` 并列
- bridge-manager 收到回调后转发给 adapter 的卡片控制器

### D4: 卡片生命周期管理位置

**选择：feishu-adapter 内部，不新建独立文件**

理由：
- claude-to-im 是轻量库，不像 CodePilot 有独立的 channel plugin 架构
- 卡片状态（cardId、sequence、throttle）与 adapter 生命周期绑定
- 保持一个文件内聚，降低理解成本

## 文件改动清单

### claude-to-im 仓库

#### 1. `src/lib/bridge/adapters/feishu-adapter.ts` — 主要改动

新增 ~300 行，修改 ~100 行

**新增：**
- `FeishuCardState` 接口 — 每条流式回复的卡片状态（cardId, messageId, sequence, startTime, toolCalls, thinking, pendingText, throttleTimer）
- `activeCards: Map<string, FeishuCardState>` — 按 chatId 索引的活跃卡片
- `createStreamingCard(chatId, replyToMessageId?)` — 创建 CardKit v2 卡片 + 发送消息
- `updateCardContent(chatId, text)` — 节流更新卡片内容（~200ms）
- `updateToolProgress(chatId, tools: ToolCallInfo[])` — 更新工具进度（合入卡片内容）
- `finalizeCard(chatId, status, responseText)` — 关闭流式模式、最终更新（含 footer）
- `cleanupCard(chatId)` — 异常时清理卡片状态
- WSClient monkey-patch：`handleEventData` 重写 `type="card"` → `type="event"`
- `card.action.trigger` 事件注册 + handler：按钮点击 → synthetic callback InboundMessage

**修改：**
- `start()` — 添加 monkey-patch 和 card.action.trigger 注册
- `send()` — 检测如果有活跃卡片则跳过（流式卡片走独立路径）
- `sendPermissionCard()` — 改为真正的 card action 按钮（column_set + column + button）
- `onMessageStart()` — 创建流式卡片（💭 Thinking...）
- `onMessageEnd()` — 清理卡片状态

**新增方法签名（暴露给 bridge-manager）：**
```typescript
// 通过 BaseChannelAdapter 的可选方法或直接类型断言调用
onStreamText?(chatId: string, fullText: string): void;
onToolEvent?(chatId: string, tools: ToolCallInfo[]): void;
onStreamEnd?(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string): void;
```

#### 2. `src/lib/bridge/markdown/feishu.ts` — 扩展

新增 ~60 行

- `buildStreamingCardBody(text, toolCalls?, thinking?)` — 构建流式卡片的 elements 数组
- `buildToolProgressMarkdown(tools: ToolCallInfo[])` — 工具进度 markdown
- `buildFinalCardBody(text, toolCalls, footer)` — 构建最终卡片（含 footer hr + notation）
- `formatElapsed(ms)` — 耗时格式化

#### 3. `src/lib/bridge/conversation-engine.ts` — 小改动

新增 ~20 行

- 新增 `OnToolEvent` 回调类型
- `processMessage()` 新增 `onToolEvent` 参数
- `consumeStream()` 在 `tool_use` / `tool_result` case 中调用 `onToolEvent`

#### 4. `src/lib/bridge/bridge-manager.ts` — 中等改动

修改 ~60 行

- `handleMessage()` 中：
  - 检测 adapter 是否为 FeishuAdapter 且支持流式卡片
  - 如果是：在 `onMessageStart` 中创建卡片，构建 `onPartialText` 回调转发给 adapter
  - 构建 `onToolEvent` 回调转发给 adapter
  - 在 response 发送前调用 `finalizeCard`（如果有活跃卡片）
  - 在 finally 中调用 `cleanupCard`（异常清理）
  - 有活跃卡片时跳过 `deliverResponse`（内容已在卡片中）
- `deliverResponse()` — feishu 分支添加"如果有活跃卡片则 skip"逻辑

#### 5. `src/lib/bridge/channel-adapter.ts` — 小改动

新增 ~10 行

- 新增可选方法声明：
  ```typescript
  onStreamText?(chatId: string, fullText: string): void;
  onToolEvent?(chatId: string, tools: ToolCallInfo[]): void;
  onStreamEnd?(chatId: string, status: string, responseText: string): Promise<void>;
  ```

#### 6. `src/lib/bridge/types.ts` — 小改动

新增 ~10 行

- 新增 `ToolCallInfo` 接口：`{ id: string; name: string; status: 'running' | 'complete' | 'error' }`

### claude-to-im-skill 仓库

#### 7. `references/setup-guides.md` — 飞书部分更新

- Step C（Events & Callbacks）新增 `card.action.trigger` 回调说明
- Step A（Permissions）新增 6 个权限 scope：
  - `cardkit:card:write` / `cardkit:card:read`
  - `im:message:update`
  - `im:message.reactions:read` / `im:message.reactions:write_only`
  - `im:resource`（已有则确认）
- 新增升级提醒：旧用户需补充权限 + 重新发布

## 实施顺序

一次性实施，但按依赖顺序编码：

1. **types.ts** — 新增 ToolCallInfo
2. **channel-adapter.ts** — 新增可选方法声明
3. **markdown/feishu.ts** — 新增卡片构建函数
4. **conversation-engine.ts** — 新增 onToolEvent 回调
5. **feishu-adapter.ts** — 核心实现（卡片生命周期 + monkey-patch + 按钮）
6. **bridge-manager.ts** — 串联流式回调
7. **skill: setup-guides.md** — 更新文档

## 测试计划

- [ ] 飞书私聊发消息 → 看到 💭 Thinking... → 流式文本更新 → 最终卡片含 footer
- [ ] 触发工具调用 → 卡片实时显示 🔄 Running → ✅ Complete
- [ ] 触发权限请求 → 卡片内联 Allow/Deny 按钮 → 点击后 toast 确认 + 流程继续
- [ ] 数字快捷键 1/2/3 仍然可用（向后兼容）
- [ ] 群聊 @bot 消息 → 流式卡片正常
- [ ] /stop 中断 → 卡片 finalize 为 ⚠️ Interrupted
- [ ] 网络异常 → 卡片 graceful degradation，fallback 到最终消息

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| CardKit v2 API 需要额外权限 | 文档中明确列出，升级指南提供 scope 列表 |
| monkey-patch 在 SDK 升级后失效 | 添加 try-catch + 降级到文本命令 |
| 卡片创建失败（权限不足） | fallback 到 send() 的传统路径（post/card） |
| 流式更新频率过高被限流 | 200ms 节流 + trailing-edge flush |
