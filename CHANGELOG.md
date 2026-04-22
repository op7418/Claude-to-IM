# Changelog

## 2026-04-22

### Fix: Feishu CardKit API v1 compatibility

Migrated all CardKit API calls from the non-existent `cardkit.v2` to the actual `cardkit.v1` in `@larksuiteoapi/node-sdk` v1.61.1.

**Changes in `src/lib/bridge/adapters/feishu-adapter.ts`:**

| Operation | Before | After |
|---|---|---|
| Create card | `cardkit.v2.card.create` | `cardkit.v1.card.create` |
| Stream content | `cardkit.v2.card.streamContent({ path: { card_id } })` | `cardkit.v1.cardElement.content({ path: { card_id, element_id: 'streaming_content' } })` |
| Close streaming | `cardkit.v2.card.settings.streamingMode.set({ data: { streaming_mode: false } })` | `cardkit.v1.card.settings({ data: { settings: JSON.stringify({ streaming_mode: false }), sequence } })` |
| Finalize card | `cardkit.v2.card.update({ data: { type, data, sequence } })` | `cardkit.v1.card.update({ data: { card: { type, data }, sequence } })` |

**Root cause:** `cardkit.v2` does not exist in the SDK — accessing it returned `undefined`, causing `Cannot read properties of undefined (reading 'card')` on every streaming card creation attempt.
