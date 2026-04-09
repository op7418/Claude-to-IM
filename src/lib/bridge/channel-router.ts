/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 * Supports both:
 * - BridgeSession ID (codepilotSessionId from sessions.json)
 * - CLI session ID (sdkSessionId from ~/.claude/sessions/)
 */
export function bindToSession(
  address: ChannelAddress,
  sessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const jsonStore = store as any;

  // 1. First try: check if it's a BridgeSession (codepilotSessionId)
  let bridgeSession = store.getSession(sessionId);
  if (bridgeSession) {
    return store.upsertChannelBinding({
      channelType: address.channelType,
      chatId: address.chatId,
      codepilotSessionId: sessionId,
      workingDirectory: bridgeSession.working_directory,
      model: bridgeSession.model,
    } as any);
  }

  // 2. Second try: check if it's a CLI session (sdkSessionId)
  // Try exact match first, then prefix match
  if (jsonStore.getCliSession) {
    const cliSession = jsonStore.getCliSession(sessionId);
    if (cliSession) {
      // It's a CLI session - create a new BridgeSession and bind it
      const displayName = address.displayName || address.chatId;
      const newSession = store.createSession(
        `CLI Import: ${cliSession.sessionId.slice(0, 8)}`,
        '',  // Use default model
        undefined,  // systemPrompt
        cliSession.cwd,  // Inherit CLI's working directory
        'code',  // mode
      );

      // Set sdk_session_id on the session and all bindings
      if (jsonStore.updateSdkSessionId) {
        jsonStore.updateSdkSessionId(newSession.id, cliSession.sessionId);
      }

      // Create binding with sdkSessionId
      const binding = store.upsertChannelBinding({
        channelType: address.channelType,
        chatId: address.chatId,
        codepilotSessionId: newSession.id,
        sdkSessionId: cliSession.sessionId,
        workingDirectory: cliSession.cwd,
        model: '',
        mode: 'code',
      } as any);

      // Mark session as taken over (for state file and TTY notification)
      if (binding && jsonStore.markSessionTakenOver) {
        jsonStore.markSessionTakenOver(
          cliSession.sessionId,
          address.channelType,
          address.chatId,
          address.displayName,
        );
      }

      return binding;
    }
  }

  // 3. Check if it's an existing Bridge binding by sdkSessionId
  // This handles the case where user wants to rebind to a previously imported session
  const allBindings = store.listChannelBindings(address.channelType);
  const existingBySdkId = allBindings.find(b => b.sdkSessionId === sessionId);
  if (existingBySdkId) {
    const result = store.upsertChannelBinding({
      channelType: address.channelType,
      chatId: address.chatId,
      codepilotSessionId: existingBySdkId.codepilotSessionId,
      sdkSessionId: existingBySdkId.sdkSessionId,
      workingDirectory: existingBySdkId.workingDirectory,
      model: existingBySdkId.model,
    } as any);

    // Mark as taken over
    if (result && jsonStore.markSessionTakenOver && existingBySdkId.sdkSessionId) {
      jsonStore.markSessionTakenOver(
        existingBySdkId.sdkSessionId,
        address.channelType,
        address.chatId,
        address.displayName,
      );
    }

    return result;
  }

  // 4. Neither found
  return null;
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
