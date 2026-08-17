import type { NetworkProxyEngineState } from '@/const/platform/networkProxy';
import type { EngineIssue, ProxyNodeView } from '@/types/platform/networkProxy';

export interface EngineRuntimeState {
  activeNode: string | null;
  aliveNodeCount: number | null;
  appliedEngineGeneration: number | null;
  appliedRevision: number | null;
  controller: { secret: string; url: string } | null;
  healAttempts: number;
  lastIssue: EngineIssue | null;
  nextHealAt: number | null;
  proxyUrl: string | null;
  startedAt: number | null;
  state: NetworkProxyEngineState;
  version: string | null;
}

export interface EngineRuntime {
  getLogs: () => string[];
  getState: () => EngineRuntimeState;
  listNodes: () => Promise<ProxyNodeView[]>;
  onStateChange: (listener: (state: EngineRuntimeState) => void) => () => void;
  refreshSubscriptionNow: (id: string) => Promise<void>;
  reloadConfig: () => Promise<void>;
  restart: () => Promise<void>;
  selectNode: (name: string) => Promise<void>;
  testGroupDelay: () => Promise<ProxyNodeView[]>;
  testNodeDelay: (name: string) => Promise<number | null>;
}

export const idleEngineRuntimeState = (
  state: NetworkProxyEngineState = 'stopped',
): EngineRuntimeState => ({
  activeNode: null,
  aliveNodeCount: null,
  appliedEngineGeneration: null,
  appliedRevision: null,
  controller: null,
  healAttempts: 0,
  lastIssue: null,
  nextHealAt: null,
  proxyUrl: null,
  startedAt: null,
  state,
  version: null,
});
