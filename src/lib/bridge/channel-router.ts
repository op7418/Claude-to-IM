/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import type { BridgeStore } from './host.js';
import { getBridgeContext } from './context.js';

export interface RouterOpts {
  store: BridgeStore;
  workingDirectory?: string;
}

type CreateBindingArg = RouterOpts | string | undefined;

function getRouterStore(opts?: RouterOpts): BridgeStore {
  return opts?.store ?? getBridgeContext().store;
}

function getCreateBindingOpts(arg: CreateBindingArg): {
  store: BridgeStore;
  workingDirectory?: string;
} {
  if (typeof arg === 'string') {
    return {
      store: getRouterStore(),
      workingDirectory: arg,
    };
  }

  return {
    store: getRouterStore(arg),
    workingDirectory: arg?.workingDirectory,
  };
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress, opts?: RouterOpts): ChannelBinding {
  const store = getRouterStore(opts);
  const existing = store.getChannelBinding(address.channelType, address.chatId, address.botName);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address, opts);
  }
  return createBinding(address, opts);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  optsOrWorkingDirectory?: CreateBindingArg,
): ChannelBinding {
  const { store, workingDirectory } = getCreateBindingOpts(optsOrWorkingDirectory);
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
    botName: address.botName,
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
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
  opts?: RouterOpts,
): ChannelBinding | null {
  const store = getRouterStore(opts);
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  return store.upsertChannelBinding({
    channelType: address.channelType,
    botName: address.botName,
    chatId: address.chatId,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
  opts?: RouterOpts,
): void {
  getRouterStore(opts).updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType, opts?: RouterOpts): ChannelBinding[] {
  return getRouterStore(opts).listChannelBindings(channelType);
}
