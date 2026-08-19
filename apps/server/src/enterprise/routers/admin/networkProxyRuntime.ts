import type { EgressScopeId } from '@/const/platform/networkProxy';
import { NetworkProxySettingsModel } from '@/database/models/platform/networkProxySettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  ArtifactState,
  DesiredArtifacts,
  EgressScopeOp,
  InstanceStatusView,
  NetworkProxyArtifactKind,
  NetworkProxyConfig,
  NetworkProxyConfigView,
  NetworkProxyEngineState,
  ProxyNodeView,
  StaticProxyPersisted,
  StaticProxyUpdate,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import { getEgressCounters } from '../../services/networkProxy/egress/counters';
import { getDispatcher } from '../../services/networkProxy/egress/dispatchers';
import { getOutletHealth } from '../../services/networkProxy/egress/router';
import { artifactManager } from '../../services/networkProxy/engine/artifacts';
import { buildLocalInstanceStatus } from '../../services/networkProxy/engine/instanceStatusReporter';
import { detectEnginePlatform } from '../../services/networkProxy/engine/platform';
import { getEngineRuntime } from '../../services/networkProxy/engine/runtime';
import type { InstanceStatusUpsert } from '../../services/networkProxy/instanceStatusService';
import {
  listFreshInstanceStatuses,
  upsertInstanceStatus,
} from '../../services/networkProxy/instanceStatusService';
import { redactSecrets } from '../../services/networkProxy/redact';
import {
  applyScopeOps,
  applyStaticProxyUpdate,
  assertCanEnable,
  getNetworkProxySettings,
  isLegacyGlobalProxyActive,
  toNetworkProxyConfigView,
  updateNetworkProxySettings,
} from '../../services/networkProxy/settingsService';
import {
  peekNetworkProxySnapshot,
  publishNetworkProxyInvalidation,
} from '../../services/networkProxy/snapshot';
import {
  createSubscriptionRecord,
  deleteSubscriptionRecord,
  listSubscriptionViews,
  requestSubscriptionRefresh,
  updateSubscriptionRecord,
} from '../../services/networkProxy/subscriptionsService';
import { getPlatformInstanceId } from '../../services/platformInstance/heartbeatRuntime';

export interface NetworkProxySettingsRow {
  config: NetworkProxyConfig;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  revision: number;
  updatedAt: Date | null;
}

export interface EngineRuntimeLike {
  getLogs: () => string[];
  getState: () => {
    proxyUrl: string | null;
    state: NetworkProxyEngineState;
  };
  listNodes: () => Promise<ProxyNodeView[]>;
  refreshSubscriptionNow: (id: string) => Promise<void>;
  restart: () => Promise<void>;
  selectNode: (name: string) => Promise<void>;
  testGroupDelay: () => Promise<ProxyNodeView[]>;
  testNodeDelay: (name: string) => Promise<number | null>;
}

export interface ArtifactManagerLike {
  getStatus: () => Promise<ArtifactState[]>;
  installFromDownload: (
    kind: NetworkProxyArtifactKind,
    opts?: { proxyUrl?: string | null },
  ) => Promise<{ sha256: string; version: string }>;
  installFromStream: (
    kind: NetworkProxyArtifactKind,
    stream: NodeJS.ReadableStream,
    opts: {
      /** Operator accepted the digest-mismatch warning (upload only). */
      acceptMismatch?: boolean;
      compressed: 'auto' | 'gzip' | 'none';
      source: 'download' | 'upload';
    },
  ) => Promise<{ pinnedDigestMatch: boolean; sha256: string; version: string }>;
}

export interface NetworkProxyRuntime {
  applyScopeOps: (config: NetworkProxyConfig, ops: EgressScopeOp[]) => NetworkProxyConfig;
  applyStaticProxyUpdate: (
    current: StaticProxyPersisted | undefined,
    update: StaticProxyUpdate | null,
  ) => Promise<StaticProxyPersisted | undefined>;
  artifactManager: ArtifactManagerLike;
  assertCanEnable: (config: NetworkProxyConfig) => void;
  /** Live status of the answering instance (shown even when its heartbeat row is missing). */
  buildLocalInstanceStatus: () => Promise<InstanceStatusUpsert>;
  bumpEngineGeneration: (
    db: LobeChatDatabase | Transaction,
    input: { expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  createSubscriptionRecord: (
    db: LobeChatDatabase | Transaction,
    input: SubscriptionCreate,
    userId: string,
  ) => Promise<SubscriptionView>;
  deleteSubscriptionRecord: (db: LobeChatDatabase | Transaction, id: string) => Promise<void>;
  detectEnginePlatform: () => {
    arch: string;
    key: string | null;
    platform: string;
  };
  getDispatcherFor: ((proxyUrl: string) => unknown) | null;
  getEgressCounters: () => {
    fallbackScopes: EgressScopeId[];
  };
  getEngineRuntime: () => EngineRuntimeLike;
  getNetworkProxySettings: (db: LobeChatDatabase | Transaction) => Promise<NetworkProxySettingsRow>;
  getOutletHealth: () => {
    activeNode: string | null;
    activeNodeDelayMs: number | null;
    available: boolean;
    circuitOpen: boolean;
    kind: 'engine' | 'static';
    unavailableReason: string | null;
  };
  isLegacyGlobalProxyActive: () => boolean;
  listFreshInstanceStatuses: (
    db: LobeChatDatabase | Transaction,
    currentInstanceId: string,
  ) => Promise<InstanceStatusView[]>;
  listSubscriptionViews: (db: LobeChatDatabase | Transaction) => Promise<SubscriptionView[]>;
  peekNetworkProxySnapshot: () => { staticProxyUrl: string | null } | null;
  publishNetworkProxyInvalidation: (revision: number) => Promise<void>;
  redactSecrets: (text: string) => string;
  /** Best-effort heartbeat upsert so getStatus sees a just-installed artifact immediately. */
  reportLocalInstanceStatus?: () => Promise<boolean>;
  requestSubscriptionRefresh: (db: LobeChatDatabase | Transaction, id: string) => Promise<void>;
  setDesiredArtifacts: (
    db: LobeChatDatabase | Transaction,
    patch: DesiredArtifacts,
    input: { expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  toNetworkProxyConfigView: (config: NetworkProxyConfig) => NetworkProxyConfigView;
  updateNetworkProxySettings: (
    db: LobeChatDatabase | Transaction,
    input: { config: NetworkProxyConfig; expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  updateSubscriptionRecord: (
    db: LobeChatDatabase | Transaction,
    input: SubscriptionUpdate,
    userId: string,
  ) => Promise<SubscriptionView>;
}

let runtimeOverride: Partial<NetworkProxyRuntime> | null = null;
let loadedRuntime: NetworkProxyRuntime | null = null;

export const setNetworkProxyRuntimeForTests = (next: Partial<NetworkProxyRuntime> | null) => {
  runtimeOverride = next;
  loadedRuntime = null;
};

const asDb = (db: LobeChatDatabase | Transaction): LobeChatDatabase => db as LobeChatDatabase;

const loadNetworkProxyRuntime = async (): Promise<NetworkProxyRuntime> => ({
  applyScopeOps,
  applyStaticProxyUpdate,
  artifactManager,
  assertCanEnable,
  bumpEngineGeneration: async (db, input) =>
    new NetworkProxySettingsModel(asDb(db)).bumpEngineGeneration(input),
  createSubscriptionRecord: (db, input, userId) =>
    createSubscriptionRecord(asDb(db), input, userId),
  deleteSubscriptionRecord: (db, id) => deleteSubscriptionRecord(asDb(db), id),
  buildLocalInstanceStatus: () => buildLocalInstanceStatus(getEngineRuntime()),
  detectEnginePlatform,
  getDispatcherFor: getDispatcher,
  getEgressCounters,
  getEngineRuntime,
  getNetworkProxySettings: (db) => getNetworkProxySettings(asDb(db)),
  getOutletHealth,
  isLegacyGlobalProxyActive,
  listFreshInstanceStatuses: (db, instanceId) => listFreshInstanceStatuses(asDb(db), instanceId),
  listSubscriptionViews: (db) => listSubscriptionViews(asDb(db)),
  peekNetworkProxySnapshot,
  publishNetworkProxyInvalidation,
  redactSecrets,
  reportLocalInstanceStatus: async () => {
    try {
      const { getServerDB } = await import('@/database/core/db-adaptor');
      return await upsertInstanceStatus(
        await getServerDB(),
        await buildLocalInstanceStatus(getEngineRuntime()),
      );
    } catch {
      return false;
    }
  },
  requestSubscriptionRefresh: (db, id) => requestSubscriptionRefresh(asDb(db), id),
  setDesiredArtifacts: async (db, patch, input) =>
    new NetworkProxySettingsModel(asDb(db)).setDesiredArtifacts(patch, input),
  toNetworkProxyConfigView,
  updateNetworkProxySettings: (db, input) => updateNetworkProxySettings(asDb(db), input),
  updateSubscriptionRecord: (db, input, userId) =>
    updateSubscriptionRecord(asDb(db), input, userId),
});

export const getNetworkProxyRuntime = async (): Promise<NetworkProxyRuntime> => {
  if (runtimeOverride) {
    return runtimeOverride as NetworkProxyRuntime;
  }
  loadedRuntime ??= await loadNetworkProxyRuntime();
  return loadedRuntime;
};

export const currentInstanceId = (): string => getPlatformInstanceId();
