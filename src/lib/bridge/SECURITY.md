# Claude-to-IM Security

## Threat Model

The bridge exposes an LLM to messages from IM platforms. Key threats:

1. **Unauthorized access**: Anyone who messages the bot gets LLM access
2. **Prompt injection**: Malicious input via IM messages
3. **Command injection**: Path traversal or shell metacharacters in /cwd commands
4. **Denial of service**: Message flooding
5. **Permission bypass**: Forged callback queries or double-click race conditions

## Mitigations

### Authentication & Authorization

Each adapter implements `isAuthorized(userId, chatId)`:
- **Telegram**: `telegram_bridge_allowed_users` CSV whitelist
- **Discord**: `bridge_discord_allowed_users`, `_allowed_channels`, `_allowed_guilds` with group policy
- **Feishu**: `bridge_feishu_allowed_users` + group policy + mention requirement

Unauthorized messages are silently dropped (no response leak).

### Input Validation (`security/validators.ts`)

- `validateWorkingDirectory()`: Rejects relative paths, `..` traversal, shell metacharacters (`|;&$`)
- `validateSessionId()`: Hex/UUID format, 32-64 chars
- `isDangerousInput()`: Detects path traversal, command injection, null bytes, control characters
- `sanitizeInput()`: Strips control characters (except `\n`, `\t`), enforces max length (10,000 chars)
- `validateMode()`: Whitelist (`plan`, `code`, `ask`, `yolo`)

### Rate Limiting (`security/rate-limiter.ts`)

Token bucket algorithm: 20 messages/minute per chat ID. Idle buckets cleaned up periodically.

### Permission Security

- **Origin validation**: Callback must come from same chat AND same message ID as the original permission prompt
- **Atomic dedup**: `markPermissionLinkResolved()` uses atomic check-and-set to prevent race conditions from concurrent button clicks
- **In-memory dedup**: `recentPermissionForwards` map prevents duplicate forwarding (30s window)

### Audit Logging

All inbound and outbound messages are logged via `store.insertAuditLog()` with:
- Channel type, chat ID, direction, message ID, truncated summary
- Dangerous input blocks are logged with `[BLOCKED]` prefix
- Truncated inputs are logged with `[TRUNCATED]` prefix

### Transport Security

- All platform APIs use HTTPS
- Bot tokens are stored in the host's settings store (not in bridge code)
- Token masking in UI prevents accidental exposure

## Recommendations for Deployments

1. Always configure `allowed_users` — never run with open access
2. Use separate bot tokens for bridge vs. notifications
3. Monitor audit logs for unusual patterns
4. Keep bot token rotation in your operational runbook
5. Consider network-level restrictions (firewall, VPN) for the host application
