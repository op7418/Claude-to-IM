#!/usr/bin/env bash
set -euo pipefail

# Migrate claude-to-im single-bot data into a per-bot data directory.
# Usage: ./scripts/migrate-to-multi-bot.sh --bot-name <name> [--dry-run]

usage() {
  echo "Usage: $0 --bot-name <name> [--dry-run]"
}

log() {
  echo "==> $*"
}

dry_log() {
  echo "[dry-run] $*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

run_or_print() {
  if [[ "$DRY_RUN" == true ]]; then
    dry_log "$*"
  else
    "$@"
  fi
}

BOT_NAME=""
DRY_RUN=false
CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-name)
      [[ $# -ge 2 ]] || fail "--bot-name requires a value"
      BOT_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ -n "$BOT_NAME" ]] || { usage; fail "--bot-name is required"; }
[[ "$BOT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || fail "--bot-name must use alphanumeric characters and dashes only, and must start with an alphanumeric character"

DATA_DIR="$CTI_HOME/data"
BOT_DIR="$DATA_DIR/$BOT_NAME"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="$DATA_DIR.bak.$TIMESTAMP"
DATA_FILES=(
  sessions.json
  bindings.json
  permissions.json
  offsets.json
  dedup.json
  audit.json
)

command -v shasum >/dev/null 2>&1 || fail "shasum is required"
command -v node >/dev/null 2>&1 || fail "node is required to update bindings.json"
[[ -d "$DATA_DIR" ]] || fail "Data directory not found: $DATA_DIR"
[[ ! -e "$BOT_DIR" ]] || fail "Target bot data directory already exists: $BOT_DIR"
[[ ! -e "$BACKUP_DIR" ]] || fail "Backup path already exists: $BACKUP_DIR"

log "Migration settings"
echo "CTI_HOME:  $CTI_HOME"
echo "Data dir:  $DATA_DIR"
echo "Bot name:  $BOT_NAME"
echo "Target:    $BOT_DIR"
echo "Backup:    $BACKUP_DIR"
echo "Dry run:   $DRY_RUN"
echo

log "Recording source checksums"
CHECKSUM_FILE="$(mktemp "${TMPDIR:-/tmp}/cti-migrate-checksums.XXXXXX")"
trap 'rm -f "$CHECKSUM_FILE"' EXIT

for filename in "${DATA_FILES[@]}"; do
  src="$DATA_DIR/$filename"
  if [[ -f "$src" ]]; then
    shasum -a 256 "$src" >> "$CHECKSUM_FILE"
    echo "Found: $filename"
  else
    echo "Missing, skip: $filename"
  fi
done

if [[ -d "$DATA_DIR/messages" ]]; then
  while IFS= read -r -d '' message_file; do
    shasum -a 256 "$message_file" >> "$CHECKSUM_FILE"
  done < <(find "$DATA_DIR/messages" -type f -print0 | sort -z)
  echo "Found: messages/"
else
  echo "Missing, skip: messages/"
fi
echo

log "Backing up data directory"
run_or_print cp -a "$DATA_DIR" "$BACKUP_DIR"
echo

log "Creating per-bot data directory"
run_or_print mkdir -p "$BOT_DIR"
echo

log "Copying data files"
for filename in "${DATA_FILES[@]}"; do
  src="$DATA_DIR/$filename"
  dst="$BOT_DIR/$filename"
  if [[ -f "$src" ]]; then
    run_or_print cp -a "$src" "$dst"
  fi
done

if [[ -d "$DATA_DIR/messages" ]]; then
  run_or_print cp -a "$DATA_DIR/messages" "$BOT_DIR/messages"
fi
echo

if [[ "$DRY_RUN" == true ]]; then
  log "Updating copied bindings.json"
  dry_log "Would rewrite keys in $BOT_DIR/bindings.json from channelType:chatId to channelType:$BOT_NAME:chatId and add botName=\"$BOT_NAME\""
  echo
  log "Verifying source checksums"
  dry_log "Would verify original source files are unchanged with shasum -a 256 -c"
  echo
  log "Dry run complete. No files were changed."
  exit 0
fi

log "Verifying copied files before mutation"
for filename in "${DATA_FILES[@]}"; do
  src="$DATA_DIR/$filename"
  dst="$BOT_DIR/$filename"
  if [[ -f "$src" ]]; then
    src_sum="$(shasum -a 256 "$src" | awk '{print $1}')"
    dst_sum="$(shasum -a 256 "$dst" | awk '{print $1}')"
    [[ "$src_sum" == "$dst_sum" ]] || fail "Checksum mismatch after copying $filename"
  fi
done

if [[ -d "$DATA_DIR/messages" ]]; then
  while IFS= read -r -d '' src; do
    rel="${src#"$DATA_DIR/messages/"}"
    dst="$BOT_DIR/messages/$rel"
    [[ -f "$dst" ]] || fail "Missing copied message file: $dst"
    src_sum="$(shasum -a 256 "$src" | awk '{print $1}')"
    dst_sum="$(shasum -a 256 "$dst" | awk '{print $1}')"
    [[ "$src_sum" == "$dst_sum" ]] || fail "Checksum mismatch after copying messages/$rel"
  done < <(find "$DATA_DIR/messages" -type f -print0)
fi
echo

log "Updating copied bindings.json"
BINDINGS="$BOT_DIR/bindings.json"
if [[ -f "$BINDINGS" ]]; then
  BOT_NAME="$BOT_NAME" BINDINGS="$BINDINGS" node <<'NODE'
const fs = require('fs');

const botName = process.env.BOT_NAME;
const bindingsPath = process.env.BINDINGS;
const raw = fs.readFileSync(bindingsPath, 'utf8');
const bindings = raw.trim() ? JSON.parse(raw) : {};
const migrated = {};
let changed = 0;

for (const [key, value] of Object.entries(bindings)) {
  const parts = key.split(':');
  const nextValue = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, botName }
    : value;

  if (parts.length === 2) {
    migrated[`${parts[0]}:${botName}:${parts[1]}`] = nextValue;
    changed += 1;
  } else {
    migrated[key] = nextValue;
  }
}

fs.writeFileSync(bindingsPath, JSON.stringify(migrated, null, 2) + '\n');
console.log(`Updated ${changed} binding key(s) in ${bindingsPath}`);
NODE
else
  echo "No bindings.json found in copied data; skipped binding rewrite."
fi
echo

log "Verifying original source files are unchanged"
if [[ -s "$CHECKSUM_FILE" ]]; then
  shasum -a 256 -c "$CHECKSUM_FILE"
else
  echo "No source files were present for checksum verification."
fi
echo

log "Migration complete"
echo "Original data was not deleted."
echo "Backup created: $BACKUP_DIR"
echo "Per-bot data:   $BOT_DIR"
echo
echo "Manual cleanup after verifying the daemon works:"
echo "  rm -f \"$DATA_DIR\"/{sessions.json,bindings.json,permissions.json,offsets.json,dedup.json,audit.json}"
echo "  rm -rf \"$DATA_DIR/messages\""
