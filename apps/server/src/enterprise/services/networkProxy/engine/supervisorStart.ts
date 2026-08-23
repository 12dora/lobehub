import { randomBytes } from 'node:crypto';

import {
  NETWORK_PROXY_ENGINE_GROUP_NAME,
  NETWORK_PROXY_ENGINE_LISTENER_USER,
} from '@/const/platform/networkProxy';

import { artifactManager } from './artifacts';
import { getNetworkProxySnapshot } from './b1';
import { ensureSecureDirectory } from './fsSecure';
import { removeStaleRuntimeDirs, resolveDataDir } from './platform';
import { allocateLoopbackPorts } from './ports';
import { createEngineRestClient } from './restClient';
import { writeGeneratedConfig } from './supervisorConfig';
import type { SupervisorHandle } from './supervisorHandle';
import { waitUntilHealthy } from './supervisorHealth';
import { issueCodeForStartFailure, pickInformationalIssue, PORT_RETRY } from './supervisorHelpers';
import { killStalePid, spawnEngineProcess, writePidFile } from './supervisorProcess';

let startEnginePreflightForTest: (() => Promise<void> | void) | null = null;
let failFinalStartSnapshotForTest = false;

/** Test-only: throw from runtime-dir prep before the per-attempt retry loop. */
export const setStartEnginePreflightForTest = (hook: (() => Promise<void> | void) | null): void => {
  startEnginePreflightForTest = hook;
};

/** Test-only: make the post-attempts snapshot read throw once. */
export const setFailFinalStartSnapshotForTest = (fail: boolean): void => {
  failFinalStartSnapshotForTest = fail;
};

export const abortStartup = async (
  host: SupervisorHandle,
  error: unknown,
  spawned: boolean,
): Promise<void> => {
  if (!host.state.lastIssue) {
    host.setIssue(issueCodeForStartFailure(error, spawned), error);
  }
  await host.stopEngineNow().catch(() => undefined);
  let generation = host.lastAttemptedEngineGeneration;
  if (generation === null) {
    const snapshot = await getNetworkProxySnapshot().catch(() => null);
    if (snapshot) {
      host.markAttemptedGeneration(snapshot.engineGeneration);
      generation = snapshot.engineGeneration;
    }
  }
  host.enterErrorState(generation);
};

export const runStartEngineAttemptsBody = async (host: SupervisorHandle): Promise<boolean> => {
  await startEnginePreflightForTest?.();
  const dataDir = resolveDataDir();
  const paths = host.paths();
  await removeStaleRuntimeDirs(dataDir, paths.instanceId);
  await ensureSecureDirectory(paths.runtimeDir, { create: true, root: dataDir });

  const opening = await getNetworkProxySnapshot();
  host.markAttemptedGeneration(opening.engineGeneration);

  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_RETRY; attempt += 1) {
    let spawned = false;
    try {
      const snapshot = await getNetworkProxySnapshot();
      host.markAttemptedGeneration(snapshot.engineGeneration);
      const artifact = await artifactManager.resolveEngineBinary({ reverify: true });
      if (!host.desiredRun(snapshot, artifact)) {
        await host.stopEngineNow();
        host.patchStopped(artifact, 'desired');
        return false;
      }
      if (!artifact) {
        host.patchStopped(null, 'desired');
        return false;
      }
      await killStalePid(artifact.path, host.paths().pidPath);

      const [mixedPort, controllerPort] = await allocateLoopbackPorts(2);
      host.mixedPort = mixedPort;
      host.controllerPort = controllerPort;
      host.listenerPassword = randomBytes(32).toString('base64url');
      host.controllerSecret = randomBytes(32).toString('base64url');
      await writeGeneratedConfig(host, snapshot);
      host.rest = createEngineRestClient({
        controller: `http://127.0.0.1:${controllerPort}`,
        secret: host.controllerSecret,
      });

      const latest = await getNetworkProxySnapshot();
      if (!host.desiredRun(latest, artifact)) {
        await host.stopEngineNow();
        host.patchStopped(artifact, 'desired');
        return false;
      }

      const child = spawnEngineProcess(artifact.path, paths.runtimeDir, paths.configPath);
      child.on('error', (error) => {
        host.setIssue('spawn_failed', error);
      });
      host.child = child;
      spawned = true;
      if (child.pid) await writePidFile(child.pid, host.paths().pidPath);
      child.stdout?.on('data', (chunk: Buffer) => host.logs.append(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => host.logs.append(chunk.toString('utf8')));
      child.once('exit', (code, signal) => {
        void host.onChildExit(code, signal).catch((error) => host.setIssueFromUnknown(error));
      });

      await waitUntilHealthy(host.rest, host.startWaitMs);
      host.version = artifact.version;
      host.startedAt = Date.now();
      // Applied IDs must match the snapshot the YAML was generated from. If a
      // newer snapshot landed after generate (see `latest` above), leave
      // applied behind so the next reconcile reloads — or restarts on a
      // generation bump — instead of treating stale YAML as current.
      host.appliedRevision = snapshot.revision;
      host.appliedEngineGeneration = snapshot.engineGeneration;
      host.markAttemptedGeneration(snapshot.engineGeneration);
      const proxyUrl = `http://${NETWORK_PROXY_ENGINE_LISTENER_USER}:${host.listenerPassword}@127.0.0.1:${mixedPort}`;
      const geodataIssue = pickInformationalIssue(host.state.lastIssue);
      host.patchState({
        appliedEngineGeneration: snapshot.engineGeneration,
        appliedRevision: snapshot.revision,
        controller: { secret: host.controllerSecret!, url: `http://127.0.0.1:${controllerPort}` },
        healAttempts: 0,
        lastIssue: geodataIssue,
        nextHealAt: null,
        proxyUrl,
        startedAt: host.startedAt,
        state: 'running',
        version: host.version,
      });
      if (snapshot.config.outlet.mode === 'manual' && snapshot.config.outlet.manualNodeName) {
        await host.rest
          .selectProxy(NETWORK_PROXY_ENGINE_GROUP_NAME, snapshot.config.outlet.manualNodeName)
          .catch((error) => host.setIssue('node_select_failed', error));
      }
      host.startHealthLoop();
      return true;
    } catch (error) {
      lastError = error;
      host.setIssue(issueCodeForStartFailure(error, spawned), error);
      await host.stopEngineNow();
    }
  }
  if (!host.state.lastIssue && lastError !== undefined) {
    host.setIssue(issueCodeForStartFailure(lastError, false), lastError);
  }
  let generation = host.lastAttemptedEngineGeneration;
  try {
    if (failFinalStartSnapshotForTest) {
      failFinalStartSnapshotForTest = false;
      throw new Error('snapshot failed');
    }
    const latest = await getNetworkProxySnapshot();
    generation = latest.engineGeneration;
  } catch (error) {
    if (!host.state.lastIssue) host.setIssueFromUnknown(error);
  }
  host.enterErrorState(generation);
  return false;
};
