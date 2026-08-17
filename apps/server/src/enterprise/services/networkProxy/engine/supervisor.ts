import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  NETWORK_PROXY_ENGINE_GROUP_NAME,
  NETWORK_PROXY_ENGINE_LISTENER_USER,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';
import { startPersistentWorkerScheduler } from '@/server/enterprise/jobs/persistentWorkerScheduler';
import type { ProxyNodeView } from '@/types/platform/networkProxy';

import type { InstalledArtifact } from './artifacts';
import { artifactManager, materializeGeodataIntoRuntime } from './artifacts';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import {
  getNetworkProxySnapshot,
  isLegacyGlobalProxyActive,
  onNetworkProxySnapshotChange,
  redactSecrets,
} from './b1';
import { generateEngineConfig } from './configGenerator';
import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { ensureSecureDirectory, removeIfPresent, writeFileAtomically } from './fsSecure';
import { createEngineLogRing } from './logs';
import {
  detectEnginePlatform,
  enginePaths,
  removeStaleRuntimeDirs,
  resolveDataDir,
} from './platform';
import { allocateLoopbackPorts } from './ports';
import type { EngineRestClient } from './restClient';
import { createEngineRestClient } from './restClient';
import {
  refreshSubscriptionNow as fetchSubscriptionNow,
  syncSubscriptionsFromSnapshot,
} from './subscriptionFetcher';
import type { EngineRuntime, EngineRuntimeState } from './types';
import { idleEngineRuntimeState } from './types';

const PORT_RETRY = 3;
const DEFAULT_START_WAIT_MS = 8_000;
const HEALTH_POLL_MS = 400;

let afterWriteGeneratedConfigForTest: (() => void) | null = null;

/** Test-only: run after YAML is written so a newer snapshot can land before spawn. */
export const setAfterWriteGeneratedConfigForTest = (hook: (() => void) | null): void => {
  afterWriteGeneratedConfigForTest = hook;
};

export interface EngineSupervisorOptions {
  crashLimit?: number;
  crashWindowMs?: number;
  healthFailuresBeforeRestart?: number;
  healthIntervalMs?: number;
  startWaitMs?: number;
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const memberAlive = (
  proxy: { alive?: boolean; history?: { delay: number }[] } | undefined,
): boolean => {
  if (!proxy) return false;
  if (proxy.alive === true) return true;
  const last = proxy.history?.at(-1)?.delay ?? 0;
  return last > 0;
};

export class EngineSupervisor implements EngineRuntime {
  private appliedEngineGeneration: number | null = null;
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
      await this.rest.providerUpdate(`sub_${id}`).catch((error) => this.setLastError(error));
    }
  };

  startLoops = (): void => {
    if (this.loopsStarted) return;
    this.loopsStarted = true;
    this.installProcessHooks();
    onNetworkProxySnapshotChange(() => {
      void this.reconcile().catch((error) => this.setLastError(error));
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
              .catch((error) => this.setLastError(error));
          }
        }
      },
    });
    void this.reconcile().catch((error) => this.setLastError(error));
  };

  reconcile = async (): Promise<void> =>
    this.runExclusive(async () => {
      const snapshot = await getNetworkProxySnapshot();
      await this.ensureDesiredArtifacts(snapshot);

      const binary = await artifactManager.resolveEngineBinary().catch(() => null);
      if (!this.desiredRun(snapshot, binary)) {
        await this.stopEngineNow();
        this.patchStopped(binary);
        return;
      }

      if (
        this.state.state === 'error' &&
        snapshot.engineGeneration <= (this.appliedEngineGeneration ?? -1)
      ) {
        return;
      }

      if (snapshot.engineGeneration > (this.appliedEngineGeneration ?? -1)) {
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

  private runExclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await next;
    } catch (error) {
      this.setLastError(error);
      throw error;
    }
  };

  private paths = () => enginePaths(resolveDataDir());

  private desiredRun = (
    snapshot: NetworkProxyRuntimeSnapshot,
    binary: InstalledArtifact | null,
  ): boolean =>
    snapshot.config.masterEnabled &&
    snapshot.config.outlet.kind === 'engine' &&
    Boolean(binary) &&
    !isLegacyGlobalProxyActive();

  private requireRest = (): EngineRestClient => {
    const rest = this.rest;
    if (!rest) {
      return throwNetworkProxyError(
        NETWORK_PROXY_ENGINE_ERROR_CODES.ENGINE_ERROR,
        'engine REST client is not available',
      );
    }
    return rest;
  };

  private patchState = (patch: Partial<EngineRuntimeState>): void => {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  };

  private setLastError = (error: unknown): void => {
    const message = redactSecrets(error instanceof Error ? error.message : 'engine error');
    this.patchState({ lastError: message });
  };

  private patchStopped = (binary: InstalledArtifact | null): void => {
    const { key } = detectEnginePlatform();
    this.patchState({
      ...idleEngineRuntimeState(key ? (binary ? 'stopped' : 'not_installed') : 'unsupported'),
      appliedEngineGeneration: this.appliedEngineGeneration,
      appliedRevision: this.appliedRevision,
      lastError: this.state.lastError,
    });
  };

  private installProcessHooks = (): void => {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    const killSync = () => {
      try {
        this.child?.kill('SIGTERM');
      } catch {
        // best-effort
      }
    };
    const reraise = (signal: NodeJS.Signals) => {
      killSync();
      process.kill(process.pid, signal);
    };
    process.once('SIGTERM', () => reraise('SIGTERM'));
    process.once('SIGINT', () => reraise('SIGINT'));
    process.once('exit', killSync);
  };

  private ensureDesiredArtifacts = async (snapshot: NetworkProxyRuntimeSnapshot): Promise<void> => {
    const proxyUrl = snapshot.config.downloadViaStaticProxy ? snapshot.staticProxyUrl : null;
    const desired = snapshot.desiredArtifacts;
    const status = await artifactManager.getStatus();
    const byKind = new Map(status.map((item) => [item.kind, item]));
    const need = (kind: 'engine' | 'geoip' | 'geosite', version: string | undefined) => {
      if (!version) return false;
      const current = byKind.get(kind);
      return !current?.installed || current.version !== version;
    };
    if (need('engine', desired.engine?.version)) {
      this.patchState({ state: 'installing' });
      await artifactManager.installFromDownload('engine', { proxyUrl });
    }
    if (need('geoip', desired.geoip?.commit)) {
      this.patchState({ state: 'installing' });
      await artifactManager.installFromDownload('geoip', { proxyUrl });
    }
    if (need('geosite', desired.geosite?.commit)) {
      this.patchState({ state: 'installing' });
      await artifactManager.installFromDownload('geosite', { proxyUrl });
    }
  };

  private writeGeneratedConfig = async (snapshot: NetworkProxyRuntimeSnapshot): Promise<void> => {
    if (this.mixedPort === null || this.controllerPort === null) {
      throw new Error('engine ports are not allocated');
    }
    if (!this.listenerPassword || !this.controllerSecret) {
      throw new Error('engine credentials are not allocated');
    }
    const dataDir = resolveDataDir();
    const paths = this.paths();
    await ensureSecureDirectory(paths.runtimeDir, { create: true, root: dataDir });
    await ensureSecureDirectory(paths.providersDir, { create: true, root: dataDir });
    let geodataReady = false;
    if (snapshot.config.ruleMode === 'smart') {
      try {
        geodataReady = await materializeGeodataIntoRuntime(paths.runtimeDir);
        if (!geodataReady) this.setLastError(new Error('geodata invalid'));
      } catch {
        geodataReady = false;
        this.setLastError(new Error('geodata invalid'));
      }
    }
    const { providerFiles } = await syncSubscriptionsFromSnapshot({
      engineProxyUrl: this.state.proxyUrl,
      engineState: this.state.state,
      providersDir: paths.providersDir,
      snapshot,
    });
    const yaml = generateEngineConfig({
      controllerPort: this.controllerPort,
      controllerSecret: this.controllerSecret,
      geodataReady,
      listenerPassword: this.listenerPassword,
      mixedPort: this.mixedPort,
      providerFiles,
      providersDir: paths.providersDir,
      snapshot,
    });
    await writeFileAtomically({
      contents: yaml,
      mode: 0o600,
      path: paths.configPath,
      root: dataDir,
    });
    afterWriteGeneratedConfigForTest?.();
  };

  private killStalePid = async (binPath: string): Promise<void> => {
    const paths = this.paths();
    let raw: string;
    try {
      raw = await readFile(paths.pidPath, 'utf8');
    } catch {
      return;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
      await removeIfPresent(paths.pidPath);
      return;
    }
    // Darwin (and any host without /proc/<pid>/exe): never kill an unverified identity.
    if (process.platform === 'darwin') return;
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`);
      if (path.resolve(exe) !== path.resolve(binPath)) return;
    } catch {
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    await sleep(500);
    await removeIfPresent(paths.pidPath);
  };

  private writePidFile = async (pid: number): Promise<void> => {
    await writeFileAtomically({
      contents: String(pid),
      mode: 0o600,
      path: this.paths().pidPath,
      root: resolveDataDir(),
    });
  };

  private restartNow = async (): Promise<boolean> => {
    this.crashTimes = [];
    this.backoffMs = 1000;
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
    } finally {
      this.starting = false;
    }
  };

  private startEngineAttempts = async (): Promise<boolean> => {
    const dataDir = resolveDataDir();
    const paths = this.paths();
    await removeStaleRuntimeDirs(dataDir, paths.instanceId);
    await ensureSecureDirectory(paths.runtimeDir, { create: true, root: dataDir });

    let lastError: unknown;
    for (let attempt = 0; attempt < PORT_RETRY; attempt += 1) {
      try {
        const snapshot = await getNetworkProxySnapshot();
        const artifact = await artifactManager.resolveEngineBinary({ reverify: true });
        if (!this.desiredRun(snapshot, artifact)) {
          await this.stopEngineNow();
          this.patchStopped(artifact);
          return false;
        }
        if (!artifact) {
          this.patchStopped(null);
          return false;
        }
        await this.killStalePid(artifact.path);

        const [mixedPort, controllerPort] = await allocateLoopbackPorts(2);
        this.mixedPort = mixedPort;
        this.controllerPort = controllerPort;
        this.listenerPassword = randomBytes(32).toString('base64url');
        this.controllerSecret = randomBytes(32).toString('base64url');
        await this.writeGeneratedConfig(snapshot);
        this.rest = createEngineRestClient({
          controller: `http://127.0.0.1:${controllerPort}`,
          secret: this.controllerSecret,
        });

        const latest = await getNetworkProxySnapshot();
        if (!this.desiredRun(latest, artifact)) {
          await this.stopEngineNow();
          this.patchStopped(artifact);
          return false;
        }

        const env = {
          HOME: paths.runtimeDir,
          PATH: process.env.PATH,
          SSL_CERT_FILE: process.env.SSL_CERT_FILE,
          TZ: process.env.TZ,
        };

        const child: ChildProcess = spawn(
          artifact.path,
          ['-d', paths.runtimeDir, '-f', paths.configPath],
          {
            env: env as unknown as typeof process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.on('error', (error) => {
          this.setLastError(error);
        });
        this.child = child;
        if (child.pid) await this.writePidFile(child.pid);
        child.stdout?.on('data', (chunk: Buffer) => this.logs.append(chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => this.logs.append(chunk.toString('utf8')));
        child.once('exit', (code, signal) => {
          void this.onChildExit(code, signal).catch((error) => this.setLastError(error));
        });

        await this.waitUntilHealthy();
        this.version = artifact.version;
        this.startedAt = Date.now();
        // Applied IDs must match the snapshot the YAML was generated from. If a
        // newer snapshot landed after generate (see `latest` above), leave
        // applied behind so the next reconcile reloads — or restarts on a
        // generation bump — instead of treating stale YAML as current.
        this.appliedRevision = snapshot.revision;
        this.appliedEngineGeneration = snapshot.engineGeneration;
        const proxyUrl = `http://${NETWORK_PROXY_ENGINE_LISTENER_USER}:${this.listenerPassword}@127.0.0.1:${mixedPort}`;
        const geodataNote = this.state.lastError?.includes('geodata invalid')
          ? this.state.lastError
          : null;
        this.patchState({
          appliedEngineGeneration: snapshot.engineGeneration,
          appliedRevision: snapshot.revision,
          controller: { secret: this.controllerSecret, url: `http://127.0.0.1:${controllerPort}` },
          lastError: geodataNote,
          proxyUrl,
          startedAt: this.startedAt,
          state: 'running',
          version: this.version,
        });
        if (snapshot.config.outlet.mode === 'manual' && snapshot.config.outlet.manualNodeName) {
          await this.rest
            .selectProxy(NETWORK_PROXY_ENGINE_GROUP_NAME, snapshot.config.outlet.manualNodeName)
            .catch((error) => this.setLastError(error));
        }
        this.startHealthLoop();
        return true;
      } catch (error) {
        lastError = error;
        this.setLastError(error);
        await this.stopEngineNow();
      }
    }
    this.setLastError(lastError);
    this.patchState({ state: 'error' });
    return false;
  };

  private waitUntilHealthy = async (): Promise<void> => {
    if (!this.rest) throw new Error('engine REST client missing');
    const deadline = Date.now() + this.startWaitMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.rest.version();
        return;
      } catch (error) {
        lastError = error;
        await sleep(HEALTH_POLL_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('engine did not become healthy');
  };

  private startHealthLoop = (): void => {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      void this.healthTick().catch((error) => this.setLastError(error));
    }, this.healthIntervalMs);
    this.healthTimer.unref();
  };

  private stopHealthLoop = (): void => {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  };

  private healthTick = async (): Promise<void> => {
    if (!this.rest || !this.child) return;
    try {
      await this.rest.version();
      this.healthFailures = 0;
      const group = await this.rest.getGroup(NETWORK_PROXY_ENGINE_GROUP_NAME);
      const proxies = await this.rest.getProxies();
      const alive = group.all.filter((name) => memberAlive(proxies[name])).length;
      this.patchState({
        activeNode: group.now || null,
        aliveNodeCount: alive,
        state: alive > 0 ? 'running' : 'degraded',
      });
    } catch (error) {
      this.healthFailures += 1;
      this.setLastError(error);
      if (this.healthFailures >= this.healthFailuresBeforeRestart) {
        await this.restart().catch((restartError) => this.setLastError(restartError));
      }
    }
  };

  private onChildExit = async (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> => {
    if (this.starting || this.desiredStop) {
      this.child = null;
      return;
    }
    await this.runExclusive(async () => {
      this.child = null;
      this.stopHealthLoop();
      this.rest = null;
      this.controllerSecret = null;
      this.listenerPassword = null;
      this.mixedPort = null;
      this.controllerPort = null;
      await removeIfPresent(this.paths().pidPath);
      if (this.desiredStop) {
        this.desiredStop = false;
        return;
      }
      const now = Date.now();
      this.crashTimes = this.crashTimes.filter((at) => now - at <= this.crashWindowMs);
      this.crashTimes.push(now);
      this.setLastError(
        new Error(`engine exited code=${code ?? 'null'} signal=${signal ?? 'null'}`),
      );
      if (this.crashTimes.length >= this.crashLimit) {
        this.patchState({
          ...idleEngineRuntimeState('error'),
          appliedEngineGeneration: this.appliedEngineGeneration,
          appliedRevision: this.appliedRevision,
          lastError: this.state.lastError,
        });
        return;
      }
      this.backoffMs = Math.min(
        this.backoffMs * 2,
        NETWORK_PROXY_LIMITS.ENGINE_RESTART_BACKOFF_MAX_MS,
      );
      await sleep(this.backoffMs);
      await this.startEngineNow();
    });
  };

  private stopEngineNow = async (): Promise<void> => {
    this.desiredStop = true;
    this.stopHealthLoop();
    const child = this.child;
    this.child = null;
    this.rest = null;
    if (child?.pid && isPidAlive(child.pid)) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolveWait) => child.once('exit', () => resolveWait())),
        sleep(2000),
      ]);
      if (child.pid && isPidAlive(child.pid)) child.kill('SIGKILL');
    }
    this.controllerSecret = null;
    this.listenerPassword = null;
    this.mixedPort = null;
    this.controllerPort = null;
    this.startedAt = null;
    await removeIfPresent(this.paths().pidPath);
    this.patchState({
      controller: null,
      proxyUrl: null,
      startedAt: null,
    });
  };

  private reloadConfigNow = async (): Promise<void> => {
    const snapshot = await getNetworkProxySnapshot();
    try {
      await this.writeGeneratedConfig(snapshot);
      if (this.rest && this.child) {
        await this.rest.reloadConfig(this.paths().configPath);
        this.appliedRevision = snapshot.revision;
        this.patchState({ appliedRevision: snapshot.revision });
        return;
      }
    } catch (error) {
      this.setLastError(error);
    }
    await this.restartNow();
  };

  private readNodes = async (): Promise<ProxyNodeView[]> => {
    const rest = this.requireRest();
    const group = await rest.getGroup(NETWORK_PROXY_ENGINE_GROUP_NAME);
    const proxies = await rest.getProxies();
    const providers = await rest.getProviders().catch(() => ({}));
    const owner = new Map<string, string>();
    for (const [providerName, provider] of Object.entries(providers)) {
      const subscriptionId = providerName.startsWith('sub_') ? providerName.slice(4) : null;
      for (const proxy of provider.proxies) owner.set(proxy.name, subscriptionId ?? providerName);
    }
    return group.all.map((name) => {
      const proxy = proxies[name];
      const last = proxy?.history?.at(-1)?.delay;
      return {
        alive: memberAlive(proxy),
        delayMs: last && last > 0 ? last : null,
        name,
        subscriptionId: owner.get(name) ?? null,
        type: proxy?.type ?? 'unknown',
      };
    });
  };
}

export type { EngineRuntime, EngineRuntimeState };
