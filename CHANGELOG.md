# Changelog

## 2026-04-22 (session 2)

### Feishu streaming card UX improvements

**Anti-flicker: separate streaming elements**
- Split streaming card into two independent elements: `streaming_content` (response text) and `tool_progress` (tool calls)
- Text updates no longer re-render the tool list and vice versa
- Added `buildToolProgressMarkdown` import to `feishu-adapter.ts`

**Tool call details in progress display**
- `buildToolProgressMarkdown` now shows relevant input details per tool:
  - `Bash`: first line of command (truncated to 60 chars)
  - `Read`/`Write`/`Edit`: file path
  - `Grep`: pattern, `Glob`: pattern, `WebFetch`: URL, `WebSearch`: query
- `ToolCallInfo` type extended with optional `input` field
- `OnToolEvent` callback and `bridge-manager` updated to pass `input`

**Newline fix in streaming cards**
- `flushCardUpdate` now applies `preprocessFeishuMarkdown` before sending content, ensuring code fences have proper newlines

**Green header on streaming and final cards**
- Both streaming and finalized cards now show `🟢 Answer` header with `template: 'green'`

**Permission card reply threading**
- Permission cards are now sent as replies to the user's original message (`im.message.reply`) instead of standalone messages, keeping the conversation thread clean

**Permission card cleanup on resolution**
- After clicking Allow/Allow Session/Deny, the permission card is deleted (`im.message.delete`)
- "Permission response recorded" confirmation message suppressed for Feishu (card toast is sufficient)
- `FeishuAdapter.updatePermissionCardResolved()` method added



Migrated all CardKit API calls from the non-existent `cardkit.v2` to the actual `cardkit.v1` in `@larksuiteoapi/node-sdk` v1.61.1.

**Changes in `src/lib/bridge/adapters/feishu-adapter.ts`:**

| Operation | Before | After |
|---|---|---|
| Create card | `cardkit.v2.card.create` | `cardkit.v1.card.create` |
| Stream content | `cardkit.v2.card.streamContent({ path: { card_id } })` | `cardkit.v1.cardElement.content({ path: { card_id, element_id: 'streaming_content' } })` |
| Close streaming | `cardkit.v2.card.settings.streamingMode.set({ data: { streaming_mode: false } })` | `cardkit.v1.card.settings({ data: { settings: JSON.stringify({ streaming_mode: false }), sequence } })` |
| Finalize card | `cardkit.v2.card.update({ data: { type, data, sequence } })` | `cardkit.v1.card.update({ data: { card: { type, data }, sequence } })` |

**Root cause:** `cardkit.v2` does not exist in the SDK — accessing it returned `undefined`, causing `Cannot read properties of undefined (reading 'card')` on every streaming card creation attempt.
