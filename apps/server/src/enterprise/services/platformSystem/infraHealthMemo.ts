import {
  INFRA_SETTINGS_INVALIDATION_SCOPE,
  INFRA_SETTINGS_LIMITS,
} from '@/const/platform/infraSettings';
import type {
  AdminSystemDocumentRenderHealth,
  AdminSystemSandboxHealth,
} from '@/server/enterprise/contracts/adminSystem';

import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';
import type { DocumentRenderHealthProbe } from './documentRenderProbe';
import type { DependencyHealth, InfraEnvBag } from './infraDependencyConfig';
import {
  keyManagementHealth,
  objectStorageHealth,
  probeKeyManagement,
} from './infraDependencyConfig';
import { probeObjectStorageHealth } from './infraProbes';
import type { SandboxHealthProbe } from './sandboxProbe';

const LIVE_PROBE_TTL_MS = INFRA_SETTINGS_LIMITS.SNAPSHOT_TTL_MS;

export interface LiveInfraHealth {
  documentRender?: AdminSystemDocumentRenderHealth | null;
  keyManagement: DependencyHealth;
  objectStorage: DependencyHealth;
  sandbox?: AdminSystemSandboxHealth | null;
}

export type LiveInfraHealthProbe = (env: InfraEnvBag) => Promise<DependencyHealth>;

interface LiveInfraHealthSlot {
  epoch: string;
  expiresAt: number;
  value: LiveInfraHealth;
}

interface LiveInfraHealthFlight {
  epoch: string;
  generation: number;
  promise: Promise<LiveInfraHealth>;
}

let resolved: LiveInfraHealthSlot | null = null;
let inflight: LiveInfraHealthFlight | null = null;
/** Bumped by invalidate so a still-running probe cannot re-seed the cache. */
let generation = 0;

export const resetInfraHealthMemoForTest = (): void => {
  generation = 0;
  inflight = null;
  resolved = null;
};

export const invalidateInfraHealthMemo = (): void => {
  generation += 1;
  resolved = null;
};

const readEpoch = async (getScopeEpoch?: () => Promise<string>): Promise<string> => {
  try {
    return await (
      getScopeEpoch ?? (() => getPlatformConfigScopeVersion(INFRA_SETTINGS_INVALIDATION_SCOPE))
    )();
  } catch {
    return resolved?.epoch ?? '0';
  }
};

const shouldSkipLiveProbe = (health: DependencyHealth): boolean =>
  health.status === 'disabled' || health.errorCategory === 'configuration_incomplete';

const settledOrUnavailable = (
  result: PromiseSettledResult<DependencyHealth>,
  checkedAt: Date,
): DependencyHealth => {
  if (result.status === 'fulfilled') return result.value;
  return {
    errorCategory: 'operation_unavailable',
    lastCheckedAt: checkedAt,
    status: 'unavailable',
  };
};

const runLiveProbes = async (params: {
  keyManagementEnv: InfraEnvBag;
  now: () => Date;
  objectStorageEnv: InfraEnvBag;
  probeDocumentRender?: DocumentRenderHealthProbe;
  probeKeyManagement: LiveInfraHealthProbe;
  probeObjectStorageHealth: LiveInfraHealthProbe;
  probeSandbox?: SandboxHealthProbe;
}): Promise<LiveInfraHealth> => {
  const objectStorageClassified = objectStorageHealth(params.objectStorageEnv);
  const keyManagementClassified = keyManagementHealth(params.keyManagementEnv);
  const [objectStorageResult, keyManagementResult, sandboxResult, documentRenderResult] =
    await Promise.allSettled([
      shouldSkipLiveProbe(objectStorageClassified)
        ? Promise.resolve(objectStorageClassified)
        : params.probeObjectStorageHealth(params.objectStorageEnv),
      shouldSkipLiveProbe(keyManagementClassified)
        ? Promise.resolve(keyManagementClassified)
        : params.probeKeyManagement(params.keyManagementEnv),
      params.probeSandbox ? params.probeSandbox() : Promise.resolve(null),
      params.probeDocumentRender ? params.probeDocumentRender() : Promise.resolve(null),
    ]);
  const checkedAt = params.now();
  // A probe that throws (instead of reporting unavailable) would otherwise vanish from the
  // status page with no trace — surface the reason so an operator can tell "module off"
  // from "probe crashed".
  for (const [name, result] of [
    ['sandbox', sandboxResult],
    ['documentRender', documentRenderResult],
  ] as const) {
    if (result.status === 'rejected') {
      console.warn(
        `[platformSystem] ${name} health probe failed:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }
  return {
    documentRender: documentRenderResult.status === 'fulfilled' ? documentRenderResult.value : null,
    keyManagement: settledOrUnavailable(keyManagementResult, checkedAt),
    objectStorage: settledOrUnavailable(objectStorageResult, checkedAt),
    sandbox: sandboxResult.status === 'fulfilled' ? sandboxResult.value : null,
  };
};

/**
 * In-process 30s memo + single-flight for the two live status-page probes.
 * Epoch is `INFRA_SETTINGS_INVALIDATION_SCOPE` so a settings save drops the cache.
 */
const matchingFlight = (epoch: string): LiveInfraHealthFlight | null =>
  inflight && inflight.epoch === epoch && inflight.generation === generation ? inflight : null;

export const getLiveInfraHealth = async (params: {
  getScopeEpoch?: () => Promise<string>;
  keyManagementEnv: InfraEnvBag;
  now?: () => Date;
  objectStorageEnv: InfraEnvBag;
  probeDocumentRender?: DocumentRenderHealthProbe;
  probeKeyManagement?: LiveInfraHealthProbe;
  probeObjectStorageHealth?: LiveInfraHealthProbe;
  probeSandbox?: SandboxHealthProbe;
}): Promise<LiveInfraHealth> => {
  const epoch = await readEpoch(params.getScopeEpoch);
  const nowMs = Date.now();
  if (resolved && resolved.epoch === epoch && resolved.expiresAt > nowMs) {
    return resolved.value;
  }
  const joined = matchingFlight(epoch);
  if (joined) return joined.promise;

  const startedGeneration = generation;
  const startedEpoch = epoch;
  // The flight object is created before the promise settles, so the commit check
  // below can compare identities without a self-referencing initializer.
  const flight: LiveInfraHealthFlight = {
    epoch: startedEpoch,
    generation: startedGeneration,
    promise: undefined as unknown as Promise<LiveInfraHealth>,
  };
  const flightPromise = (async () => {
    const value = await runLiveProbes({
      keyManagementEnv: params.keyManagementEnv,
      now: params.now ?? (() => new Date()),
      objectStorageEnv: params.objectStorageEnv,
      probeDocumentRender: params.probeDocumentRender,
      probeKeyManagement: params.probeKeyManagement ?? probeKeyManagement,
      probeObjectStorageHealth: params.probeObjectStorageHealth ?? probeObjectStorageHealth,
      probeSandbox: params.probeSandbox,
    });
    // A later epoch or invalidate() must not let this result become the memo.
    if (inflight === flight && generation === startedGeneration) {
      resolved = { epoch: startedEpoch, expiresAt: Date.now() + LIVE_PROBE_TTL_MS, value };
    }
    return value;
  })();
  flight.promise = flightPromise;
  inflight = flight;
  try {
    return await flightPromise;
  } finally {
    if (inflight === flight) inflight = null;
  }
};
