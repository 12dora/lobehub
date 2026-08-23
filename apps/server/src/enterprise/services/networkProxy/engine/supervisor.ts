import type { ChildProcess } from 'node:child_process';

import type { NetworkProxyEngineIssueCode } from '@/const/platform/networkProxy';
import {
  NETWORK_PROXY_ENGINE_GROUP_NAME,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';
import { startPersistentWorkerScheduler } from '@/server/enterprise/jobs/persistentWorkerScheduler';
import type { ProxyNodeView } from '@/types/platform/networkProxy';

import type { InstalledArtifact } from './artifacts';
import { artifactManager } from './artifacts';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import { getNetworkProxySnapshot, onNetworkProxySnapshotChange } from './b1';
import { resolveEngineIssueCode } from './errors';
import { createEngineLogRing } from './logs';
import { detectEnginePlatform, enginePaths, resolveDataDir } from './platform';
import type { EngineRestClient } from './restClient';
import {
  refreshSubscriptionNow as fetchSubscriptionNow,
  syncSubscriptionsFromSnapshot,
} from './subscriptionFetcher';
import {
  ensureDesiredArtifacts,
  reloadConfigNow as reloadGeneratedConfig,
} from './supervisorConfig';
import type { SupervisorHandle } from './supervisorHandle';
import {
  readNodes,
  requireEngineRest,
  startHealthLoop as beginHealthLoop,
  stopHealthLoop as clearHealthTimer,
} from './supervisorHealth';
import { DEFAULT_START_WAIT_MS, makeIssue } from './supervisorHelpers';
import {
  healBackoffMs as computeHealBackoffMs,
  isDesiredEngineRun,
  isUnattemptedGeneration as isGenerationUnattempted,
  nextHealOnEnterError,
  stoppedStateFor,
} from './supervisorPolicy';
import {
  installProcessHooks as bindProcessHooks,
  onChildExit as handleChildExit,
  stopEngineNow as haltEngine,
} from './supervisorProcess';
import { abortStartup, runStartEngineAttemptsBody } from './supervisorStart';
import type { EngineRuntime, EngineRuntimeState } from './types';
import { idleEngineRuntimeState } from './types';

export { setAfterWriteGeneratedConfigForTest } from './supervisorConfig';
export {
  setFailFinalStartSnapshotForTest,
  setStartEnginePreflightForTest,
} from './supervisorStart';

export interface EngineSupervisorOptions {
  crashLimit?: number;
  crashWindowMs?: number;
  healBackoffBaseMs?: number;
  healBackoffMaxMs?: number;
  healthFailuresBeforeRestart?: number;
  healthIntervalMs?: number;
  startWaitMs?: number;
}

export class EngineSupervisor implements EngineRuntime {
  private appliedEngineGeneration: number | null = null;
  /** Last engineGeneration we tried to start — not only the last successful apply. */
  private lastAttemptedEngineGeneration: number | null = null;
  private appliedRevision: number | null = null;
  private backoffMs = 1000;
  private child: ChildProcess | null = null;
  private controllerPort: number | null = null;
  private controllerSecret: string | null = null;
  private readonly crashLimit: number;
  private readonly crashWindowMs: number;
  private crashTimes: number[] = [];
  private desiredStop = false;
  private readonly healthFailuresBeforeRestart: number;
  private healthFailures = 0;
  private readonly healthIntervalMs: number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly healBackoffBaseMs: number;
  private readonly healBackoffMaxMs: number;
  private hooksInstalled = false;
  private listenerPassword: string | null = null;
  private readonly listeners = new Set<(state: EngineRuntimeState) => void>();
  private readonly logs = createEngineLogRing();
  private loopsStarted = false;
  private mixedPort: number | null = null;
  private pendingRestart = false;
  private queue: Promise<unknown> = Promise.resolve();
  private starting = false;
  private rest: EngineRestClient | null = null;
  private startedAt: number | null = null;
  private readonly startWaitMs: number;
  private state: EngineRuntimeState = idleEngineRuntimeState(
    detectEnginePlatform().key ? 'stopped' : 'unsupported',
  );
  private version: string | null = null;

  constructor(options: EngineSupervisorOptions = {}) {
    this.crashLimit = options.crashLimit ?? NETWORK_PROXY_LIMITS.ENGINE_CRASH_LIMIT;
    this.crashWindowMs = options.crashWindowMs ?? NETWORK_PROXY_LIMITS.ENGINE_CRASH_WINDOW_MS;
    this.healthFailuresBeforeRestart =
      options.healthFailuresBeforeRestart ??
      NETWORK_PROXY_LIMITS.ENGINE_HEALTH_FAILURES_BEFORE_RESTART;
    this.healthIntervalMs =
      options.healthIntervalMs ?? NETWORK_PROXY_LIMITS.ENGINE_HEALTH_INTERVAL_MS;
    this.healBackoffBaseMs =
      options.healBackoffBaseMs ?? NETWORK_PROXY_LIMITS.ENGINE_HEAL_BACKOFF_BASE_MS;
    this.healBackoffMaxMs =
      options.healBackoffMaxMs ?? NETWORK_PROXY_LIMITS.ENGINE_HEAL_BACKOFF_MAX_MS;
    this.startWaitMs = options.startWaitMs ?? DEFAULT_START_WAIT_MS;
  }

  getState = (): EngineRuntimeState => ({ ...this.state });

  onStateChange = (listener: (state: EngineRuntimeState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getLogs = (): string[] => this.logs.get();

  restart = async (): Promise<void> => {
    this.pendingRestart = true;
    this.clearHealState();
    this.patchState({ lastIssue: null });
    await this.runExclusive(async () => {
      if (!this.pendingRestart) return;
      this.pendingRestart = false;
      await this.restartNow();
    });
  };

  reloadConfig = async (): Promise<void> => this.runExclusive(async () => this.reloadConfigNow());

  listNodes = async (): Promise<ProxyNodeView[]> => this.readNodes();

  testGroupDelay = async (): Promise<ProxyNodeView[]> => {
    const rest = this.requireRest();
    const snapshot = await getNetworkProxySnapshot();
    await rest.groupDelay(
      NETWORK_PROXY_ENGINE_GROUP_NAME,
      snapshot.config.outlet.latencyTestUrl,
      NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS,
    );
    return this.readNodes();
  };

  testNodeDelay = async (name: string): Promise<number | null> => {
    const rest = this.requireRest();
    const snapshot = await getNetworkProxySnapshot();
    return rest.proxyDelay(
      name,
      snapshot.config.outlet.latencyTestUrl,
      NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS,
    );
  };

  selectNode = async (name: string): Promise<void> => {
    await this.requireRest().selectProxy(NETWORK_PROXY_ENGINE_GROUP_NAME, name);
    this.patchState({ activeNode: name });
  };

  refreshSubscriptionNow = async (id: string): Promise<void> => {
    const snapshot = await getNetworkProxySnapshot();
    const paths = this.paths();
    await fetchSubscriptionNow({
      engineProxyUrl: this.state.proxyUrl,
      engineState: this.state.state,
      id,
      providersDir: paths.providersDir,
      snapshot,
    });
    if (this.rest) {
      await this.rest
        .providerUpdate(`sub_${id}`)
        .catch((error) => this.setIssue('subscription_sync_failed', error));
    }
  };

  startLoops = (): void => {
    if (this.loopsStarted) return;
    this.loopsStarted = true;
    this.installProcessHooks();
    onNetworkProxySnapshotChange(() => {
      void this.reconcile().catch((error) => this.setIssueFromUnknown(error));
    });
    startPersistentWorkerScheduler({
      baseIntervalMs: this.healthIntervalMs,
      namespace: 'network-proxy-reconcile',
      run: async () => this.reconcile(),
    });
    startPersistentWorkerScheduler({
      baseIntervalMs: 60_000,
      namespace: 'network-proxy-subscriptions',
      run: async () => {
        const snapshot = await getNetworkProxySnapshot();
        await syncSubscriptionsFromSnapshot({
          engineProxyUrl: this.state.proxyUrl,
          engineState: this.state.state,
          providersDir: this.paths().providersDir,
          snapshot,
        });
        if (this.rest) {
          for (const sub of snapshot.subscriptions.filter((item) => item.enabled)) {
            await this.rest
              .providerUpdate(`sub_${sub.id}`)
              .catch((error) => this.setIssue('subscription_sync_failed', error));
          }
        }
      },
    });
    void this.reconcile().catch((error) => this.setIssueFromUnknown(error));
  };

  reconcile = async (): Promise<void> =>
    this.runExclusive(async () => {
      const snapshot = await getNetworkProxySnapshot();
      await this.ensureDesiredArtifacts(snapshot);

      const binary = await artifactManager.resolveEngineBinary().catch(() => null);
      if (!this.desiredRun(snapshot, binary)) {
        await this.stopEngineNow();
        this.patchStopped(binary, 'desired');
        return;
      }

      if (this.state.state === 'error') {
        if (this.isUnattemptedGeneration(snapshot.engineGeneration)) {
          this.pendingRestart = false;
          this.clearHealState();
          this.patchState({ lastIssue: null });
          await this.restartNow();
          return;
        }
        if (Date.now() < (this.state.nextHealAt ?? Number.POSITIVE_INFINITY)) return;
        this.patchState({ healAttempts: this.state.healAttempts + 1 });
        const ok = await this.healNow();
        if (!ok && this.state.state === 'error') {
          const nextHealAt = Date.now() + this.healBackoffMs(this.state.healAttempts);
          this.patchState({ nextHealAt });
        }
        return;
      }

      if (this.isUnattemptedGeneration(snapshot.engineGeneration)) {
        this.pendingRestart = false;
        await this.restartNow();
        return;
      }

      if (!this.child) {
        await this.startEngineNow();
        return;
      }

      if (snapshot.revision !== this.appliedRevision) {
        await this.reloadConfigNow();
      }
    });

  private handle = (): SupervisorHandle => this as unknown as SupervisorHandle;

  private runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await next;
    } catch (error) {
      if (!this.state.lastIssue) this.setIssueFromUnknown(error);
      throw error;
    }
  };

  private paths = () => enginePaths(resolveDataDir());

  private desiredRun = (
    snapshot: NetworkProxyRuntimeSnapshot,
    binary: InstalledArtifact | null,
  ): boolean => isDesiredEngineRun(snapshot, binary);

  private requireRest = (): EngineRestClient => requireEngineRest(this.rest);

  private patchState = (patch: Partial<EngineRuntimeState>): void => {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  };

  private setIssue = (code: NetworkProxyEngineIssueCode, error?: unknown): void => {
    this.patchState({ lastIssue: makeIssue(code, error) });
  };

  private setIssueFromUnknown = (error: unknown): void => {
    this.setIssue(resolveEngineIssueCode(error), error);
  };

  private healBackoffMs = (attempts: number): number =>
    computeHealBackoffMs(attempts, this.healBackoffBaseMs, this.healBackoffMaxMs);

  private clearHealState = (): void => {
    this.patchState({ healAttempts: 0, nextHealAt: null });
  };

  private isUnattemptedGeneration = (generation: number): boolean =>
    isGenerationUnattempted(
      generation,
      this.lastAttemptedEngineGeneration,
      this.appliedEngineGeneration,
    );

  private markAttemptedGeneration = (generation: number): void => {
    this.lastAttemptedEngineGeneration = generation;
  };

  private enterErrorState = (
    generation: number | null = this.lastAttemptedEngineGeneration,
  ): void => {
    if (generation !== null) this.markAttemptedGeneration(generation);
    const next = nextHealOnEnterError(
      this.state.healAttempts,
      this.state.nextHealAt,
      this.healBackoffBaseMs,
      this.healBackoffMaxMs,
      Date.now(),
    );
    this.patchState({
      ...idleEngineRuntimeState('error'),
      appliedEngineGeneration: this.appliedEngineGeneration,
      appliedRevision: this.appliedRevision,
      healAttempts: next.healAttempts,
      lastIssue: this.state.lastIssue,
      nextHealAt: next.nextHealAt,
    });
  };

  private patchStopped = (
    binary: InstalledArtifact | null,
    reason: 'desired' | 'failure',
  ): void => {
    const { lastIssue, nextState } = stoppedStateFor(binary, reason, this.state.lastIssue);
    this.patchState({
      ...idleEngineRuntimeState(nextState),
      appliedEngineGeneration: this.appliedEngineGeneration,
      appliedRevision: this.appliedRevision,
      lastIssue,
    });
  };

  private installProcessHooks = (): void => {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    bindProcessHooks(() => this.child);
  };

  private ensureDesiredArtifacts = async (snapshot: NetworkProxyRuntimeSnapshot): Promise<void> =>
    ensureDesiredArtifacts(this.handle(), snapshot);

  private restartNow = async (): Promise<boolean> => {
    this.crashTimes = [];
    this.backoffMs = 1000;
    this.healthFailures = 0;
    await this.stopEngineNow();
    return this.startEngineNow();
  };

  /** Automatic recovery — does not reset crashTimes / backoffMs. */
  private healNow = async (): Promise<boolean> => {
    this.healthFailures = 0;
    await this.stopEngineNow();
    return this.startEngineNow();
  };

  private startEngineNow = async (): Promise<boolean> => {
    this.desiredStop = false;
    this.starting = true;
    this.patchState({ state: 'starting' });
    try {
      return await this.startEngineAttempts();
    } catch (error) {
      await abortStartup(this.handle(), error, Boolean(this.child));
      return false;
    } finally {
      this.starting = false;
    }
  };

  private startEngineAttempts = async (): Promise<boolean> => {
    try {
      return await runStartEngineAttemptsBody(this.handle());
    } catch (error) {
      await abortStartup(this.handle(), error, Boolean(this.child));
      return false;
    }
  };

  private startHealthLoop = (): void => beginHealthLoop(this.handle());

  private stopHealthLoop = (): void => clearHealthTimer(this.handle());

  private onChildExit = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> =>
    handleChildExit(this.handle(), code, signal);

  private stopEngineNow = async (): Promise<void> => haltEngine(this.handle());

  private reloadConfigNow = async (): Promise<void> => reloadGeneratedConfig(this.handle());

  private readNodes = async (): Promise<ProxyNodeView[]> => readNodes(this.requireRest());
}

export type { EngineRuntime, EngineRuntimeState };
