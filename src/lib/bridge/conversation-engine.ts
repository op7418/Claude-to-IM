/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types.js';
import type {
  BridgeStore,
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (
  perm: PermissionRequestInfo,
  opts?: { store?: BridgeStore },
) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;

/**
 * Identity of the IM user who sent the inbound message.
 * Forwarded down to the LLM provider so CC spawns with per-user env vars
 * (CTI_SENDER_CHANNEL / CTI_SENDER_USER_ID / CTI_SENDER_NAME).
 */
export interface SenderInfo {
  channel?: string;
  userId?: string;
  displayName?: string;
}

// ── Outbound file detection ──────────────────────────────────

/** Extensions that should be sent back to IM as image messages. */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico', '.svg',
]);

/** Extensions that should be sent back to IM as file messages. */
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.csv', '.xlsx', '.xls', '.docx', '.doc',
  '.pptx', '.ppt', '.zip', '.tar', '.gz', '.7z',
  '.mp3', '.mp4', '.wav', '.ogg', '.txt',
]);

/**
 * Check if a file path has a sendable extension (image or document).
 */
export function isSendableFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * Check if a file path is an image based on extension.
 */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Extract created file paths from a tool_use event.
 * Only processes "Edit" tool events (which cover both Write and Edit in the Codex SDK mapping).
 */
export function extractCreatedFiles(toolName: string, input: unknown): string[] {
  if (toolName !== 'Edit') return [];
  const files = (input as Record<string, unknown>)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((f: any) => f.kind === 'create' && typeof f.path === 'string')
    .map((f: any) => f.path as string);
}

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
  /** Absolute paths to files created by Claude during the conversation (only sendable types) */
  createdFiles: string[];
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  sender?: SenderInfo,
  opts?: { store?: BridgeStore },
): Promise<ConversationResult> {
  const ctx = getBridgeContext();
  const s = opts?.store || ctx.store;
  const { llm } = ctx;
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = s.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
      createdFiles: [],
    };
  }

  s.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { s.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = s.getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            // Back-populate disk path onto original FileAttachment so LLM
            // providers can reference non-image files by path.
            f.filePath = filePath;
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    s.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = s.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = s.getDefaultProviderId();
      if (defaultId) resolvedProvider = s.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || s.getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = s.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = llm.streamChat({
      prompt: text,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files,
      onRuntimeStatusChange: (status: string) => {
        try { s.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
      senderChannel: sender?.channel || binding.channelType,
      senderUserId: sender?.userId,
      senderName: sender?.displayName,
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent, s);
  } finally {
    clearInterval(renewalInterval);
    s.releaseSessionLock(sessionId, lockId);
    s.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  store?: BridgeStore,
): Promise<ConversationResult> {
  const s = store || getBridgeContext().store;
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  const createdFiles: string[] = [];
  let capturedSdkSessionId: string | null = null;

  // Idle timeout: abort if no stream data received within the limit (default 5 min).
  // Covers stuck CC subprocesses, zombie processes, and hung tool calls.
  const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.CTI_STREAM_IDLE_TIMEOUT_MS || '', 10) || 300_000;
  function readWithIdleTimeout() {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Stream idle timeout: no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`)),
          STREAM_IDLE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer!));
  }

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
              if (onToolEvent) {
                try { onToolEvent(toolData.id, toolData.name, 'running'); } catch { /* non-critical */ }
              }
              const newFiles = extractCreatedFiles(toolData.name, toolData.input);
              for (const f of newFiles) {
                if (isSendableFile(f)) createdFiles.push(f);
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (onToolEvent) {
                try {
                  onToolEvent(
                    resultData.tool_use_id,
                    '', // name not available in tool_result, adapter tracks by id
                    resultData.is_error ? 'error' : 'complete',
                  );
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm, { store: s }).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                s.updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                s.updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                s.syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                s.updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        s.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      createdFiles,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        s.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      createdFiles,
    };
  }
}
