import { artifactManager, materializeGeodataIntoRuntime } from './artifacts';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import { getNetworkProxySnapshot } from './b1';
import { generateEngineConfig } from './configGenerator';
import { resolveEngineIssueCode } from './errors';
import { ensureSecureDirectory, writeFileAtomically } from './fsSecure';
import { resolveDataDir } from './platform';
import { syncSubscriptionsFromSnapshot } from './subscriptionFetcher';
import type { SupervisorHandle } from './supervisorHandle';

let afterWriteGeneratedConfigForTest: (() => void) | null = null;

/** Test-only: run after YAML is written so a newer snapshot can land before spawn. */
export const setAfterWriteGeneratedConfigForTest = (hook: (() => void) | null): void => {
  afterWriteGeneratedConfigForTest = hook;
};

export const writeGeneratedConfig = async (
  host: SupervisorHandle,
  snapshot: NetworkProxyRuntimeSnapshot,
): Promise<void> => {
  if (host.mixedPort === null || host.controllerPort === null) {
    throw new Error('engine ports are not allocated');
  }
  if (!host.listenerPassword || !host.controllerSecret) {
    throw new Error('engine credentials are not allocated');
  }
  const dataDir = resolveDataDir();
  const paths = host.paths();
  await ensureSecureDirectory(paths.runtimeDir, { create: true, root: dataDir });
  await ensureSecureDirectory(paths.providersDir, { create: true, root: dataDir });
  let geodataReady = false;
  if (snapshot.config.ruleMode === 'smart') {
    try {
      geodataReady = await materializeGeodataIntoRuntime(paths.runtimeDir);
      if (!geodataReady) host.setIssue('geodata_missing');
    } catch (error) {
      geodataReady = false;
      host.setIssue('geodata_invalid', error);
    }
  }
  const { providerFiles } = await syncSubscriptionsFromSnapshot({
    engineProxyUrl: host.state.proxyUrl,
    engineState: host.state.state,
    providersDir: paths.providersDir,
    snapshot,
  });
  const yaml = generateEngineConfig({
    controllerPort: host.controllerPort,
    controllerSecret: host.controllerSecret,
    geodataReady,
    listenerPassword: host.listenerPassword,
    mixedPort: host.mixedPort,
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

export const ensureDesiredArtifacts = async (
  host: Pick<SupervisorHandle, 'patchState' | 'setIssue'>,
  snapshot: NetworkProxyRuntimeSnapshot,
): Promise<void> => {
  const proxyUrl = snapshot.config.downloadViaStaticProxy ? snapshot.staticProxyUrl : null;
  const desired = snapshot.desiredArtifacts;
  const status = await artifactManager.getStatus();
  const byKind = new Map(status.map((item) => [item.kind, item]));
  const need = (kind: 'engine' | 'geoip' | 'geosite', version: string | undefined) => {
    if (!version) return false;
    const current = byKind.get(kind);
    return !current?.installed || current.version !== version;
  };
  const install = async (kind: 'engine' | 'geoip' | 'geosite') => {
    host.patchState({ state: 'installing' });
    try {
      await artifactManager.installFromDownload(kind, { proxyUrl });
    } catch (error) {
      const mapped = resolveEngineIssueCode(error);
      host.setIssue(mapped === 'unknown' ? 'artifact_download_failed' : mapped, error);
      throw error;
    }
  };
  if (need('engine', desired.engine?.version)) await install('engine');
  if (need('geoip', desired.geoip?.commit)) await install('geoip');
  if (need('geosite', desired.geosite?.commit)) await install('geosite');
};

export const reloadConfigNow = async (host: SupervisorHandle): Promise<void> => {
  const snapshot = await getNetworkProxySnapshot();
  try {
    await writeGeneratedConfig(host, snapshot);
    if (host.rest && host.child) {
      await host.rest.reloadConfig(host.paths().configPath);
      host.appliedRevision = snapshot.revision;
      host.patchState({ appliedRevision: snapshot.revision });
      return;
    }
  } catch (error) {
    host.setIssue('config_reload_failed', error);
  }
  await host.restartNow();
};
