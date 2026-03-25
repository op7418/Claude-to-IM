/**
 * Bridge Context — dependency injection container for host interfaces.
 *
 * All bridge modules access host services through this context instead
 * of importing directly from the host application.
 *
 * The host initializes the context once at startup via `initBridgeContext()`.
 * Bridge modules access it via `getBridgeContext()`.
 */

import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
} from './host.js';

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
  /**
   * Replace the LLM provider at runtime (e.g. switching between Claude and Codex).
   */
  updateLLMProvider?(provider: LLMProvider): void;
  /**
   * Custom command handler. Called before the built-in /command switch.
   * Return a response string if handled, or undefined to fall through.
   */
  onCommand?(command: string, args: string, chatId: string): Promise<string | undefined>;
  /**
   * Message intercept hook. Called for non-command messages before routing to LLM.
   * Return a response string to send back (skipping LLM), or undefined to continue normal flow.
   */
  onMessage?(text: string, chatId: string): Promise<string | undefined>;
  /**
   * Extra help lines appended to /help output. Each line is an HTML string.
   */
  extraHelpLines?(): string[];
}

const CONTEXT_KEY = '__bridge_context__';

/**
 * Initialize the bridge context with host-provided implementations.
 * Must be called once before any bridge module is used.
 */
export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

/**
 * Get the current bridge context.
 * Throws if the context has not been initialized.
 */
export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as BridgeContext | undefined;
  if (!ctx) {
    throw new Error(
      '[bridge] Context not initialized. Call initBridgeContext() before using bridge modules.',
    );
  }
  return ctx;
}

/**
 * Check whether the bridge context has been initialized.
 */
export function hasBridgeContext(): boolean {
  return !!(globalThis as Record<string, unknown>)[CONTEXT_KEY];
}
