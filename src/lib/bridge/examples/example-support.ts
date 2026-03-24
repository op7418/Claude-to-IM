/**
 * Shared helpers for runnable bridge examples.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  query,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  BridgeStore,
  LLMProvider,
  BridgeSession,
  BridgeMessage,
  LifecycleHooks,
  PermissionGateway,
  PermissionLinkRecord,
  BridgeApiProvider,
  StreamChatParams,
} from '../host.js';
import type { ChannelBinding, ChannelType } from '../types.js';

export class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private locks = new Map<string, { lockId: string; expiresAt: number }>();
  private dedup = new Map<string, number>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private nextId = 1;

  constructor(initialSettings: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialSettings)) {
      this.settings.set(key, value);
    }
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    workingDirectory: string;
    model: string;
  }): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const now = new Date().toISOString();

    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        ...data,
        updatedAt: now,
      };
      this.bindings.set(key, updated);
      return updated;
    }

    const binding: ChannelBinding = {
      id: `binding-${this.nextId++}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: 'code',
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.set(key, {
          ...binding,
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const bindings = Array.from(this.bindings.values());
    return channelType ? bindings.filter((binding) => binding.channelType === channelType) : bindings;
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(_name: string, model: string, _systemPrompt?: string, cwd?: string): BridgeSession {
    const session: BridgeSession = {
      id: `session-${this.nextId++}`,
      working_directory: cwd || process.cwd(),
      model,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, provider_id: providerId });
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const history = this.messages.get(sessionId) || [];
    history.push({ role, content });
    this.messages.set(sessionId, history);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const history = this.messages.get(sessionId) || [];
    if (!opts?.limit || history.length <= opts.limit) {
      return { messages: history };
    }
    return { messages: history.slice(-opts.limit) };
  }

  acquireSessionLock(sessionId: string, lockId: string, _owner: string, ttlSecs: number): boolean {
    const now = Date.now();
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > now && existing.lockId !== lockId) {
      return false;
    }
    this.locks.set(sessionId, {
      lockId,
      expiresAt: now + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const existing = this.locks.get(sessionId);
    if (!existing || existing.lockId !== lockId) return;
    this.locks.set(sessionId, {
      lockId,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const existing = this.locks.get(sessionId);
    if (existing?.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(): void {}

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    for (const [key, binding] of this.bindings) {
      if (binding.codepilotSessionId === sessionId) {
        this.bindings.set(key, {
          ...binding,
          sdkSessionId,
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
  }

  updateSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, model });
  }

  syncSdkTasks(): void {}

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  insertAuditLog(): void {}

  checkDedup(key: string): boolean {
    const expiresAt = this.dedup.get(key);
    return typeof expiresAt === 'number' && expiresAt > Date.now();
  }

  insertDedup(key: string): void {
    this.dedup.set(key, Date.now() + 24 * 60 * 60 * 1000);
  }

  cleanupExpiredDedup(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.dedup) {
      if (expiresAt <= now) this.dedup.delete(key);
    }
  }

  insertOutboundRef(): void {}

  insertPermissionLink(link: {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
  }): void {
    this.permissionLinks.set(link.permissionRequestId, {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    });
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    this.permissionLinks.set(permissionRequestId, { ...link, resolved: true });
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    return Array.from(this.permissionLinks.values()).filter((link) => !link.resolved && link.chatId === chatId);
  }

  getChannelOffset(key: string): string {
    return this.settings.get(`offset:${key}`) || '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.settings.set(`offset:${key}`, offset);
  }
}

function emitSseEvent(controller: ReadableStreamDefaultController<string>, type: string, data: unknown): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  controller.enqueue(`data: ${JSON.stringify({ type, data: payload })}\n`);
}

function normalizePermissionMode(value?: string): PermissionMode {
  switch (value) {
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'plan':
    case 'dontAsk':
      return value;
    default:
      return 'default';
  }
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const blocks = (Array.isArray(message.message?.content) ? message.message.content : []) as Array<{
    type?: string;
    text?: unknown;
  }>;
  return blocks
    .filter((block): block is { type: 'text'; text: string } => (
      block?.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('');
}

function ensureLocalPromptFiles(params: StreamChatParams): Array<{ name: string; filePath: string }> {
  if (!params.files || params.files.length === 0) return [];

  const workingDirectory = params.workingDirectory || process.cwd();
  const uploadDirectory = path.join(workingDirectory, '.claude-to-im-demo-uploads');

  try {
    fs.mkdirSync(uploadDirectory, { recursive: true });
  } catch {
    return [];
  }

  const results: Array<{ name: string; filePath: string }> = [];

  for (const [index, file] of params.files.entries()) {
    const rawName = (file.name || `attachment-${index + 1}`).trim();
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || `attachment-${index + 1}`;
    const filePath = path.join(uploadDirectory, `${Date.now()}-${randomUUID()}-${safeName}`);

    try {
      fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
      results.push({ name: rawName, filePath });
    } catch {
      // Ignore individual file persistence failures in the demo path.
    }
  }

  return results;
}

function buildClaudePrompt(params: StreamChatParams): string {
  const sections: string[] = [];

  if (!params.sdkSessionId && params.conversationHistory && params.conversationHistory.length > 0) {
    sections.push('Conversation history:');
    for (const message of params.conversationHistory) {
      sections.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
    }
    sections.push('');
  }

  sections.push(params.prompt || 'Please respond to the latest user message.');

  const localFiles = ensureLocalPromptFiles(params);
  if (localFiles.length > 0) {
    sections.push('');
    sections.push('Attached files have been saved locally for inspection:');
    for (const file of localFiles) {
      sections.push(`- ${file.name}: ${file.filePath}`);
    }
    sections.push('Use these local file paths when relevant.');
  }

  return sections.join('\n');
}

interface PendingPermissionDecision {
  toolUseID: string;
  originalInput: Record<string, unknown>;
  resolve(result: PermissionResult): void;
  abortHandler?: () => void;
}

export class InteractivePermissionGateway implements PermissionGateway {
  private pending = new Map<string, PendingPermissionDecision>();

  constructor(private readonly debug = false) {}

  waitForDecision(input: {
    permissionRequestId: string;
    toolUseID: string;
    toolInput: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<PermissionResult> {
    const { permissionRequestId, toolUseID, toolInput, signal } = input;

    if (this.pending.has(permissionRequestId)) {
      this.debugLog(`Duplicate pending permission request rejected id=${permissionRequestId} pendingCount=${this.pending.size}`);
      return Promise.resolve({
        behavior: 'deny',
        message: `Duplicate permission request: ${permissionRequestId}`,
        toolUseID,
      });
    }

    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingPermissionDecision = {
        toolUseID,
        originalInput: toolInput,
        resolve: (result) => {
          if (entry.abortHandler) {
            signal.removeEventListener('abort', entry.abortHandler);
          }
          this.pending.delete(permissionRequestId);
          this.debugLog(
            `Resolved pending permission id=${permissionRequestId} behavior=${result.behavior} ` +
            `pendingCount=${this.pending.size}`,
          );
          resolve(result);
        },
      };

      entry.abortHandler = () => {
        this.debugLog(`Aborted pending permission id=${permissionRequestId}`);
        entry.resolve({
          behavior: 'deny',
          message: 'Permission request aborted',
          toolUseID,
        });
      };

      signal.addEventListener('abort', entry.abortHandler, { once: true });
      this.pending.set(permissionRequestId, entry);
      this.debugLog(`Registered pending permission id=${permissionRequestId} toolUseID=${toolUseID} pendingCount=${this.pending.size}`);
    });
  }

  resolvePendingPermission(permissionRequestId: string, resolution: {
    behavior: 'allow' | 'deny';
    message?: string;
    updatedPermissions?: unknown[];
  }): boolean {
    const pending = this.pending.get(permissionRequestId);
    if (!pending) {
      this.debugLog(`resolvePendingPermission missed id=${permissionRequestId} pendingCount=${this.pending.size}`);
      return false;
    }

    if (resolution.behavior === 'allow') {
      const updatedPermissions = resolution.updatedPermissions as PermissionUpdate[] | undefined;
      this.debugLog(
        `resolvePendingPermission allow id=${permissionRequestId} ` +
        `updatedPermissions=${updatedPermissions?.length || 0}`,
      );
      pending.resolve({
        behavior: 'allow',
        toolUseID: pending.toolUseID,
        updatedInput: pending.originalInput,
        updatedPermissions,
      });
      return true;
    }

    this.debugLog(`resolvePendingPermission deny id=${permissionRequestId} message=${resolution.message || 'Permission denied by user'}`);
    pending.resolve({
      behavior: 'deny',
      toolUseID: pending.toolUseID,
      message: resolution.message || 'Permission denied by user',
    });
    return true;
  }

  private debugLog(message: string): void {
    if (!this.debug) return;
    console.log(`[demo-permissions] ${message}`);
  }
}

export class ClaudeCodeLLM implements LLMProvider {
  constructor(private readonly options: {
    debug?: boolean;
    permissions: InteractivePermissionGateway;
  }) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const abortController = params.abortController || new AbortController();

    return new ReadableStream<string>({
      start: async (controller) => {
        let emittedText = false;
        let fallbackResultText: string | null = null;

        params.onRuntimeStatusChange?.('running');

        try {
          const prompt = buildClaudePrompt(params);
          const queryOptions = {
            abortController,
            canUseTool: async (
              toolName: string,
              input: Record<string, unknown>,
              options: {
                signal: AbortSignal;
                suggestions?: PermissionUpdate[];
                blockedPath?: string;
                decisionReason?: string;
                toolUseID: string;
              },
            ) => {
              const permissionRequestId = options.toolUseID;

              if (this.options.debug) {
                console.log('[claude-query] Permission requested:', JSON.stringify({
                  permissionRequestId,
                  toolName,
                  toolUseID: options.toolUseID,
                  toolInput: input,
                  blockedPath: options.blockedPath || null,
                  decisionReason: options.decisionReason || null,
                  suggestions: options.suggestions || [],
                }, null, 2));
              }

              emitSseEvent(controller, 'permission_request', {
                permissionRequestId,
                toolName,
                toolInput: input,
                suggestions: options.suggestions,
              });

              const decision = await this.options.permissions.waitForDecision({
                permissionRequestId,
                toolUseID: options.toolUseID,
                toolInput: input,
                signal: options.signal,
              });

              if (this.options.debug) {
                console.log('[claude-query] Permission decision returned:', JSON.stringify({
                  permissionRequestId,
                  behavior: decision.behavior,
                  toolUseID: decision.toolUseID,
                  updatedInput: 'updatedInput' in decision ? decision.updatedInput || null : null,
                  message: 'message' in decision ? decision.message || null : null,
                  updatedPermissions: 'updatedPermissions' in decision ? decision.updatedPermissions || [] : [],
                }, null, 2));
              }

              return decision;
            },
            cwd: params.workingDirectory || process.cwd(),
            includePartialMessages: false,
            model: params.model || undefined,
            permissionMode: normalizePermissionMode(params.permissionMode),
            resume: params.sdkSessionId || undefined,
            settingSources: ['user', 'project', 'local'] as SettingSource[],
            stderr: this.options?.debug
              ? (data: string) => console.error(`[claude-sdk] ${data.trimEnd()}`)
              : undefined,
            systemPrompt: params.systemPrompt
              ? { type: 'preset' as const, preset: 'claude_code' as const, append: params.systemPrompt }
              : { type: 'preset' as const, preset: 'claude_code' as const },
            tools: { type: 'preset' as const, preset: 'claude_code' as const },
          };

          this.debugLogQuery(prompt, queryOptions, params);

          const claudeQuery = query({
            prompt,
            options: queryOptions,
          });

          for await (const message of claudeQuery) {
            this.handleSdkMessage(message, controller, {
              onText: () => { emittedText = true; },
              setFallbackResultText: (text) => { fallbackResultText = text; },
            });
          }

          if (!emittedText && fallbackResultText) {
            emitSseEvent(controller, 'text', fallbackResultText);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitSseEvent(controller, 'error', message);
        } finally {
          emitSseEvent(controller, 'done', '');
          params.onRuntimeStatusChange?.('idle');
          controller.close();
        }
      },
      cancel: () => {
        abortController.abort();
      },
    });
  }

  private handleSdkMessage(
    message: SDKMessage,
    controller: ReadableStreamDefaultController<string>,
    state: {
      onText(): void;
      setFallbackResultText(text: string): void;
    },
  ): void {
    this.debugLogSdkMessage(message);

    if ('session_id' in message && message.session_id) {
      const model = message.type === 'system' && message.subtype === 'init' ? message.model : undefined;
      emitSseEvent(controller, 'status', {
        session_id: message.session_id,
        model,
      });
    }

    switch (message.type) {
      case 'assistant': {
        const text = extractAssistantText(message);
        if (text) {
          emitSseEvent(controller, 'text', text);
          state.onText();
        }
        break;
      }
      case 'result': {
        if (!message.is_error && 'result' in message) {
          state.setFallbackResultText(message.result);
        }
        emitSseEvent(controller, 'result', {
          is_error: message.is_error,
          session_id: message.session_id,
          usage: message.usage,
        });
        if (message.is_error && 'errors' in message && message.errors.length > 0) {
          emitSseEvent(controller, 'error', message.errors.join('\n'));
        }
        break;
      }
      case 'system': {
        if (message.subtype === 'status') {
          emitSseEvent(controller, 'status', {
            session_id: message.session_id,
            status: message.status,
            permissionMode: message.permissionMode,
          });
        }
        break;
      }
      case 'auth_status': {
        if (message.error) {
          emitSseEvent(controller, 'error', message.error);
        }
        break;
      }
      default:
        break;
    }
  }

  private debugLogQuery(
    prompt: string,
    queryOptions: {
      cwd: string;
      includePartialMessages: boolean;
      model?: string;
      permissionMode: PermissionMode;
      resume?: string;
      settingSources: string[];
      systemPrompt:
        | { type: 'preset'; preset: 'claude_code' }
        | { type: 'preset'; preset: 'claude_code'; append: string };
      tools: { type: 'preset'; preset: 'claude_code' };
    },
    params: StreamChatParams,
  ): void {
    if (!this.options?.debug) return;

    console.log('[claude-query] Sending query to local Claude');
    console.log('[claude-query] Meta:', JSON.stringify({
      sessionId: params.sessionId,
      sdkSessionId: params.sdkSessionId || null,
      model: queryOptions.model || null,
      cwd: queryOptions.cwd,
      permissionMode: queryOptions.permissionMode,
      resume: queryOptions.resume || null,
      conversationHistoryLength: params.conversationHistory?.length || 0,
      fileCount: params.files?.length || 0,
      settingSources: queryOptions.settingSources,
    }, null, 2));
    console.log('[claude-query] Prompt >>>');
    console.log(prompt);
    console.log('[claude-query] <<< Prompt');
  }

  private debugLogSdkMessage(message: SDKMessage): void {
    if (!this.options.debug) return;

    switch (message.type) {
      case 'user': {
        const content = Array.isArray(message.message?.content)
          ? message.message.content as Array<Record<string, unknown>>
          : [];
        const textPreview = content
          .filter((block): block is { type: 'text'; text: string } => (
            block?.type === 'text' && typeof block.text === 'string'
          ))
          .map((block) => block.text)
          .join('\n')
          .slice(0, 300) || null;

        console.log('[claude-sdk-msg] user:', JSON.stringify({
          sessionId: message.session_id,
          uuid: 'uuid' in message ? message.uuid || null : null,
          isSynthetic: message.isSynthetic ?? false,
          parentToolUseId: message.parent_tool_use_id,
          priority: message.priority || null,
          textPreview,
          toolUseResult: message.tool_use_result ?? null,
        }, null, 2));
        return;
      }

      case 'assistant': {
        const blocks = Array.isArray(message.message?.content) ? message.message.content as Array<Record<string, unknown>> : [];
        const textParts = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text));
        const toolUses = blocks
          .filter((block) => block?.type === 'tool_use')
          .map((block) => ({
            id: typeof block.id === 'string' ? block.id : null,
            name: typeof block.name === 'string' ? block.name : null,
            input: 'input' in block ? block.input : null,
          }));

        console.log('[claude-sdk-msg] assistant:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          textPreview: textParts.join('\n').slice(0, 300) || null,
          toolUses,
        }, null, 2));
        return;
      }

      case 'result': {
        console.log('[claude-sdk-msg] result:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          subtype: message.subtype,
          isError: message.is_error,
          numTurns: message.num_turns,
          stopReason: message.stop_reason,
          resultPreview: 'result' in message && typeof message.result === 'string'
            ? message.result.slice(0, 300)
            : null,
          errors: 'errors' in message ? message.errors : [],
        }, null, 2));
        return;
      }

      case 'tool_progress': {
        console.log('[claude-sdk-msg] tool_progress:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          taskId: message.task_id || null,
        }, null, 2));
        return;
      }

      case 'tool_use_summary': {
        console.log('[claude-sdk-msg] tool_use_summary:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          summary: message.summary,
          precedingToolUseIds: message.preceding_tool_use_ids,
        }, null, 2));
        return;
      }

      case 'system': {
        const payload: Record<string, unknown> = {
          sessionId: message.session_id,
          uuid: message.uuid,
          subtype: message.subtype,
        };

        if (message.subtype === 'init') {
          payload.model = message.model;
          payload.permissionMode = message.permissionMode;
          payload.tools = message.tools;
        } else if (message.subtype === 'status') {
          payload.status = message.status;
          payload.permissionMode = message.permissionMode;
        } else if (message.subtype === 'local_command_output') {
          payload.content = message.content;
        } else if (message.subtype === 'task_started') {
          payload.taskId = message.task_id;
          payload.description = message.description;
          payload.taskType = message.task_type || null;
        } else if (message.subtype === 'task_progress') {
          payload.taskId = message.task_id;
          payload.description = message.description;
          payload.lastToolName = message.last_tool_name || null;
          payload.usage = message.usage;
        } else if (message.subtype === 'task_notification') {
          payload.taskId = message.task_id;
          payload.status = message.status;
          payload.summary = message.summary;
          payload.outputFile = message.output_file;
        } else if (message.subtype === 'files_persisted') {
          payload.files = message.files;
          payload.failed = message.failed;
        }

        console.log('[claude-sdk-msg] system:', JSON.stringify(payload, null, 2));
        return;
      }

      case 'auth_status': {
        console.log('[claude-sdk-msg] auth_status:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          isAuthenticating: message.isAuthenticating,
          error: message.error || null,
          output: message.output,
        }, null, 2));
        return;
      }

      case 'stream_event': {
        console.log('[claude-sdk-msg] stream_event:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          parentToolUseId: message.parent_tool_use_id,
          eventType: message.event?.type || null,
          event: message.event,
        }, null, 2));
        return;
      }

      case 'prompt_suggestion': {
        console.log('[claude-sdk-msg] prompt_suggestion:', JSON.stringify({
          sessionId: message.session_id,
          uuid: message.uuid,
          suggestion: message.suggestion,
        }, null, 2));
        return;
      }

      default: {
        const subtype = 'subtype' in message ? message.subtype : null;
        console.log('[claude-sdk-msg] generic:', JSON.stringify({
          type: message.type,
          subtype,
          sessionId: 'session_id' in message ? message.session_id : null,
        }, null, 2));
      }
    }
  }
}

export class EchoLLM implements LLMProvider {
  constructor(private readonly options?: { markdown?: boolean; label?: string }) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = this.options?.markdown
      ? this.buildMarkdownResponse(params)
      : `Echo: ${params.prompt}`;

    return new ReadableStream<string>({
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

  private buildMarkdownResponse(params: StreamChatParams): string {
    const label = this.options?.label || 'Bridge Demo';
    const quotedPrompt = params.prompt
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const fileLines = (params.files || [])
      .map((file, index) => {
        const address = file.filePath || '(no address)';
        return `${index + 1}. ${file.name} -> ${address}`;
      });

    const sections = [
      `## ${label}`,
      '',
      `- Session: \`${params.sessionId}\``,
      `- Working Directory: \`${params.workingDirectory || process.cwd()}\``,
      `- Permission Mode: \`${params.permissionMode || 'default'}\``,
      '',
      'You said:',
      '',
      quotedPrompt,
    ];

    if (fileLines.length > 0) {
      sections.push(
        '',
        'Files:',
        '',
        ...fileLines,
      );
    }

    return sections.join('\n');
  }
}

export const allowAllPermissions: PermissionGateway = {
  resolvePendingPermission: () => true,
};

export const logLifecycle: LifecycleHooks = {
  onBridgeStart: () => console.log('[lifecycle] Bridge started'),
  onBridgeStop: () => console.log('[lifecycle] Bridge stopped'),
};
