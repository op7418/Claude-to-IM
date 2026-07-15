import fs from 'node:fs';
import path from 'node:path';

export interface ParsedInboxCaptureMessage {
  kind: string;
  rawPrefix: string;
  label: string;
  body: string;
}

export type ParsedMaterialMessage = ParsedInboxCaptureMessage;

export interface InboxStoragePaths {
  rootDir: string;
  inboxDir: string;
  dataDir: string;
  indexFile: string;
}

export interface MaterialStoragePaths extends InboxStoragePaths {
  rawDir: string;
}

export interface CaptureInboxMessageInput {
  workingDirectory: string;
  channelType: string;
  chatId: string;
  messageId: string;
  timestamp: number;
  displayName?: string;
  rawText: string;
  allowBare?: boolean;
}

export type CaptureMaterialMessageInput = CaptureInboxMessageInput;

export interface InboxCaptureResult {
  inboxId: string;
  absolutePath: string;
  relativePath: string;
  preview: string;
  kind: string;
  label: string;
  capturedAt: string;
}

export interface MaterialCaptureResult extends InboxCaptureResult {
  materialId: string;
}

interface InboxIndexEntry {
  id: string;
  kind: string;
  label: string;
  relativePath: string;
  preview: string;
  capturedAt: string;
  messageId: string;
  channelType: string;
}

interface InboxIndexFile {
  version: 1;
  nextSequenceByDay: Record<string, number>;
  recentByChat: Record<string, InboxIndexEntry[]>;
}

const INBOX_PREFIX_RE = /^\s*((素材|灵感|收件箱|inbox)[^:：\n]{0,40})[:：]\s*([\s\S]*)$/iu;
const MAX_RECENT_PER_CHAT = 20;

export function parseInboxCaptureMessage(
  rawText: string,
  options: { allowBare?: boolean } = {},
): ParsedInboxCaptureMessage | null {
  const match = INBOX_PREFIX_RE.exec(rawText);
  if (!match) {
    const body = rawText.trim();
    if (!options.allowBare || !body) return null;
    return {
      kind: 'inbox',
      rawPrefix: '',
      label: '',
      body,
    };
  }

  const rawPrefix = match[1].trim();
  const rawKind = match[2].trim();
  const kind = rawKind.toLowerCase() === 'inbox' ? 'inbox' : rawKind;
  const label = rawPrefix.slice(rawKind.length).trim().replace(/^[-_\s]+|[-_\s]+$/g, '');
  const body = match[3].trim();

  return {
    kind,
    rawPrefix,
    label,
    body,
  };
}

export function parseMaterialMessage(rawText: string): ParsedMaterialMessage | null {
  return parseInboxCaptureMessage(rawText);
}

export function resolveInboxStorage(workingDirectory: string): InboxStoragePaths {
  const techWechatRoot = path.join(workingDirectory, 'tech_wechat');
  const rootDir = fs.existsSync(techWechatRoot) ? techWechatRoot : workingDirectory;
  const inboxDir = path.join(rootDir, 'inbox');
  const dataDir = path.join(rootDir, 'data');

  return {
    rootDir,
    inboxDir,
    dataDir,
    indexFile: path.join(dataDir, 'bridge-inbox-index.json'),
  };
}

export function resolveMaterialStorage(workingDirectory: string): MaterialStoragePaths {
  const storage = resolveInboxStorage(workingDirectory);
  return {
    ...storage,
    rawDir: storage.inboxDir,
  };
}

export function captureInboxMessage(input: CaptureInboxMessageInput): InboxCaptureResult {
  const parsed = parseInboxCaptureMessage(input.rawText, { allowBare: input.allowBare });
  if (!parsed) {
    throw new Error('Message is not an inbox capture payload.');
  }
  if (!parsed.body) {
    throw new Error('Inbox capture payload is empty.');
  }

  const capturedAt = new Date(input.timestamp).toISOString();
  const storage = resolveInboxStorage(input.workingDirectory);
  const dayStamp = capturedAt.slice(0, 10);
  const dayKey = dayStamp.replace(/-/g, '');
  const index = loadIndex(storage.indexFile);
  const nextSeq = index.nextSequenceByDay[dayKey] ?? 1;

  index.nextSequenceByDay[dayKey] = nextSeq + 1;

  const inboxId = `I${dayKey}-${String(nextSeq).padStart(3, '0')}`;
  const preview = buildPreview(parsed.body);
  const absolutePath = path.join(storage.inboxDir, `${dayStamp}.md`);
  const relativePath = normalizeRelativePath(path.relative(input.workingDirectory, absolutePath));

  ensureDir(storage.inboxDir);
  ensureDir(storage.dataDir);

  appendInboxEntry(absolutePath, dayStamp, {
    inboxId,
    capturedAt,
    channelType: input.channelType,
    chatId: input.chatId,
    messageId: input.messageId,
    displayName: input.displayName || '',
    kind: parsed.kind,
    label: parsed.label,
    relativePath,
    body: parsed.body,
  });

  const chatKey = `${input.channelType}:${input.chatId}`;
  const recentEntry: InboxIndexEntry = {
    id: inboxId,
    kind: parsed.kind,
    label: parsed.label,
    relativePath,
    preview,
    capturedAt,
    messageId: input.messageId,
    channelType: input.channelType,
  };
  const currentRecent = index.recentByChat[chatKey] ?? [];
  index.recentByChat[chatKey] = [recentEntry, ...currentRecent].slice(0, MAX_RECENT_PER_CHAT);
  fs.writeFileSync(storage.indexFile, JSON.stringify(index, null, 2), 'utf8');

  return {
    inboxId,
    absolutePath,
    relativePath,
    preview,
    kind: parsed.kind,
    label: parsed.label,
    capturedAt,
  };
}

export function captureMaterialMessage(input: CaptureMaterialMessageInput): MaterialCaptureResult {
  const result = captureInboxMessage(input);
  return {
    ...result,
    materialId: result.inboxId,
  };
}

function loadIndex(indexFile: string): InboxIndexFile {
  if (!fs.existsSync(indexFile)) {
    return {
      version: 1,
      nextSequenceByDay: {},
      recentByChat: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Partial<InboxIndexFile>;
    return {
      version: 1,
      nextSequenceByDay: parsed.nextSequenceByDay ?? {},
      recentByChat: parsed.recentByChat ?? {},
    };
  } catch {
    return {
      version: 1,
      nextSequenceByDay: {},
      recentByChat: {},
    };
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function buildPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

interface InboxEntryInput {
  inboxId: string;
  capturedAt: string;
  channelType: string;
  chatId: string;
  messageId: string;
  displayName: string;
  kind: string;
  label: string;
  relativePath: string;
  body: string;
}

function appendInboxEntry(absolutePath: string, dayStamp: string, input: InboxEntryInput): void {
  const hasFile = fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 0;
  const displayLabel = input.label || input.kind;
  const header = hasFile ? '' : `# ${dayStamp} 微信 Inbox\n`;
  const entry = [
    header,
    `## ${input.inboxId} · ${displayLabel}`,
    '',
    `- 捕获时间：${input.capturedAt}`,
    `- 来源渠道：${input.channelType}`,
    `- chatId：${input.chatId}`,
    `- 来源消息：${input.messageId}`,
    `- 来源显示名：${input.displayName}`,
    `- 捕捉入口：${input.kind}`,
    `- 标签：${input.label || '无'}`,
    `- 状态：待处理`,
    `- 相对路径：${input.relativePath}`,
    '',
    '### 原始内容',
    '',
    input.body,
    '',
  ].filter((line, index) => index !== 0 || line !== '').join('\n');

  fs.appendFileSync(absolutePath, `${hasFile ? '\n\n' : ''}${entry}`, 'utf8');
}
