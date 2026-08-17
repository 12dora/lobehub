import type { NetworkProxyEngineState } from '@/const/platform/networkProxy';
import type { NetworkProxyConfig } from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { getEngineRuntime } from '../engine/runtime';
import { redactSecrets as b1RedactSecrets } from '../redact';
import { isLegacyGlobalProxyActive as b1IsLegacyGlobalProxyActive } from '../settingsService';
import { getNetworkProxyEgressView, peekNetworkProxyEgressView } from '../snapshot';
import { localRedactSecrets } from './redactLocal';

export interface EgressSnapshotView {
  config: NetworkProxyConfig;
  loadedAt: number;
  revision: number;
  staticProxyUrl: string | null;
}

export interface EgressEngineStateView {
  activeNode: string | null;
  aliveNodeCount: number | null;
  proxyUrl: string | null;
  state: NetworkProxyEngineState;
}

export interface EgressDeps {
  getEngineState: () => EgressEngineStateView;
  getSnapshot: () => Promise<EgressSnapshotView>;
  isLegacyGlobalProxyActive: () => boolean;
  peekSnapshot: () => EgressSnapshotView | null;
  redactSecrets: (text: string) => string;
}

const STOPPED_ENGINE: EgressEngineStateView = {
  activeNode: null,
  aliveNodeCount: null,
  proxyUrl: null,
  state: 'stopped',
};

const DEFAULT_SNAPSHOT: EgressSnapshotView = {
  config: createDefaultNetworkProxyConfig(),
  loadedAt: 0,
  revision: 0,
  staticProxyUrl: null,
};

let override: Partial<EgressDeps> | null = null;

const defaultPeekSnapshot = (): EgressSnapshotView | null => peekNetworkProxyEgressView();

const defaultGetSnapshot = async (): Promise<EgressSnapshotView> => {
  try {
    return await getNetworkProxyEgressView();
  } catch {
    return defaultPeekSnapshot() ?? DEFAULT_SNAPSHOT;
  }
};

const defaultGetEngineState = (): EgressEngineStateView => {
  try {
    const state = getEngineRuntime().getState();
    return {
      activeNode: state.activeNode,
      aliveNodeCount: state.aliveNodeCount,
      proxyUrl: state.proxyUrl,
      state: state.state,
    };
  } catch {
    return STOPPED_ENGINE;
  }
};

export const peekSnapshot = (): EgressSnapshotView | null =>
  override?.peekSnapshot ? override.peekSnapshot() : defaultPeekSnapshot();

export const getSnapshot = (): Promise<EgressSnapshotView> =>
  override?.getSnapshot ? override.getSnapshot() : defaultGetSnapshot();

export const getEngineState = (): EgressEngineStateView =>
  override?.getEngineState ? override.getEngineState() : defaultGetEngineState();

export const isLegacyGlobalProxyActive = (): boolean =>
  override?.isLegacyGlobalProxyActive
    ? override.isLegacyGlobalProxyActive()
    : b1IsLegacyGlobalProxyActive();

export const redactSecrets = (text: string): string => {
  if (override?.redactSecrets) return override.redactSecrets(text);
  try {
    return b1RedactSecrets(text);
  } catch {
    return localRedactSecrets(text);
  }
};

/** Test seam — pass `null` to restore production loaders. */
export const setEgressDepsForTest = (deps: Partial<EgressDeps> | null): void => {
  override = deps;
};
