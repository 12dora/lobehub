import { sandboxEnv } from '@/envs/sandbox';
import { assertModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import {
  type EffectiveSandboxSettings,
  getEffectiveSandboxSettings,
  peekEffectiveSandboxProviderKind,
} from '@/server/enterprise/services/sandboxSettings/effective';

import { MarketSandboxProvider } from './providers/market';
import { OnlyboxesSandboxProvider } from './providers/onlyboxes';
import { SandboxMiddlewareService } from './service';
import type {
  LocalSandboxProviderOptions,
  SandboxInterruptResult,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderFileExportRequest,
  SandboxProviderKind,
  SandboxPutFile,
  SandboxService,
  SandboxServiceOptions,
  SandboxSessionContext,
} from './types';

const LOCAL_SANDBOX_CAPABILITIES = {
  backgroundCommands: true,
  exportFile: true,
  files: true,
  languages: ['python', 'javascript', 'typescript'],
  persistentSession: true,
  shell: true,
  skillScripts: true,
} as const satisfies SandboxProviderCapabilities;

export const getSandboxProviderKind = (): SandboxProviderKind => {
  return (peekEffectiveSandboxProviderKind() ?? sandboxEnv.SANDBOX_PROVIDER) || 'local';
};

export const getLocalSandboxProviderOptionsFromEnv = (): LocalSandboxProviderOptions =>
  toLocalSandboxProviderOptions({
    cpus: sandboxEnv.SANDBOX_LOCAL_CPUS,
    dockerHost: sandboxEnv.SANDBOX_DOCKER_HOST,
    dockerSocket: sandboxEnv.SANDBOX_DOCKER_SOCKET,
    idleTtlSec: sandboxEnv.SANDBOX_LOCAL_IDLE_TTL_SEC,
    image: sandboxEnv.SANDBOX_LOCAL_IMAGE,
    maxContainers: sandboxEnv.SANDBOX_LOCAL_MAX_CONTAINERS,
    maxOutputBytes: sandboxEnv.SANDBOX_LOCAL_MAX_OUTPUT_BYTES,
    memoryMb: sandboxEnv.SANDBOX_LOCAL_MEMORY_MB,
    network: sandboxEnv.SANDBOX_LOCAL_NETWORK,
    pidsLimit: sandboxEnv.SANDBOX_LOCAL_PIDS_LIMIT,
    provider: 'local',
    pullPolicy: sandboxEnv.SANDBOX_LOCAL_PULL_POLICY,
    revision: 0,
    source: 'env',
    timeoutMs: sandboxEnv.SANDBOX_LOCAL_TIMEOUT_MS,
  });

export const toLocalSandboxProviderOptions = (
  settings: EffectiveSandboxSettings,
): LocalSandboxProviderOptions => {
  const pullPolicy = settings.pullPolicy;
  return {
    host: settings.dockerHost,
    idleTtlSec: settings.idleTtlSec,
    image: settings.image,
    maxContainers: settings.maxContainers,
    maxOutputBytes: settings.maxOutputBytes,
    memoryBytes: settings.memoryMb * 1024 * 1024,
    nanoCpus: Math.round(settings.cpus * 1e9),
    network: settings.network,
    pidsLimit: settings.pidsLimit,
    pullOnDemand: pullPolicy !== 'never',
    pullPolicy,
    socketPath: settings.dockerSocket,
    timeoutMs: settings.timeoutMs,
  };
};

const fingerprintLocalOptions = (options: LocalSandboxProviderOptions): string =>
  JSON.stringify({
    host: options.host ?? '',
    idleTtlSec: options.idleTtlSec,
    image: options.image,
    maxContainers: options.maxContainers,
    maxOutputBytes: options.maxOutputBytes,
    memoryBytes: options.memoryBytes,
    nanoCpus: options.nanoCpus,
    network: options.network,
    pidsLimit: options.pidsLimit,
    pullOnDemand: options.pullOnDemand,
    pullPolicy: options.pullPolicy,
    socketPath: options.socketPath ?? '',
    timeoutMs: options.timeoutMs,
  });

interface LocalSandboxProviderCtor {
  new (options: LocalSandboxProviderOptions): SandboxProvider;
}

interface LocalSandboxProviderModule {
  LocalSandboxProvider: LocalSandboxProviderCtor;
  resetLocalSandboxSupervisors: (options?: { reapContainers?: boolean }) => Promise<void>;
}

let sharedLocalProvider: SandboxProvider | undefined;
let sharedLocalProviderPromise: Promise<SandboxProvider> | undefined;
let sharedLocalFingerprint: string | undefined;

/** Dynamic so Market / Onlyboxes and a disabled sandbox module never load the Docker client. */
const loadLocalSandboxProviderModule = async (): Promise<LocalSandboxProviderModule> =>
  import('./providers/local') as Promise<LocalSandboxProviderModule>;

const disposeSharedLocalProvider = async (reapContainers: boolean): Promise<void> => {
  const hadProvider = Boolean(sharedLocalProvider || sharedLocalProviderPromise);
  sharedLocalProvider = undefined;
  sharedLocalProviderPromise = undefined;
  sharedLocalFingerprint = undefined;
  if (!hadProvider || !reapContainers) return;
  const { resetLocalSandboxSupervisors } = await loadLocalSandboxProviderModule();
  await resetLocalSandboxSupervisors({ reapContainers: true });
};

/**
 * Drop the shared local provider and reap leftover containers. Called after a
 * settings save so the next tool call rebuilds against the new options.
 */
export const rebuildSandboxProviderFromSettings = async (): Promise<void> => {
  await disposeSharedLocalProvider(true);
};

const getSharedLocalSandboxProvider = async (
  settings: EffectiveSandboxSettings,
): Promise<SandboxProvider> => {
  await assertModuleEnabled('sandbox');

  const options = toLocalSandboxProviderOptions(settings);
  const fingerprint = fingerprintLocalOptions(options);

  if (sharedLocalProvider && sharedLocalFingerprint === fingerprint) return sharedLocalProvider;
  if (sharedLocalProviderPromise && sharedLocalFingerprint === fingerprint) {
    return sharedLocalProviderPromise;
  }

  await disposeSharedLocalProvider(true);

  sharedLocalFingerprint = fingerprint;
  sharedLocalProviderPromise = loadLocalSandboxProviderModule().then(({ LocalSandboxProvider }) => {
    sharedLocalProvider = new LocalSandboxProvider(options);
    return sharedLocalProvider;
  });

  try {
    return await sharedLocalProviderPromise;
  } catch (error) {
    sharedLocalProviderPromise = undefined;
    sharedLocalFingerprint = undefined;
    throw error;
  }
};

/**
 * Adapter that is cheap to construct: Docker is imported on first tool call,
 * and only when the enterprise `sandbox` module is enabled. Provider kind and
 * local options follow `getEffectiveSandboxSettings()` (DB ?? env).
 */
class DispatchingSandboxProvider implements SandboxProvider {
  readonly capabilities = LOCAL_SANDBOX_CAPABILITIES;

  constructor(private readonly session: SandboxServiceOptions) {}

  get kind(): SandboxProviderKind {
    return getSandboxProviderKind();
  }

  async callTool(toolName: string, params: Record<string, unknown>) {
    const provider = await this.resolve();
    return provider.callTool(toolName, params);
  }

  /** Local provider only; remote providers throw and the service falls back to curl. */
  async putFiles(files: SandboxPutFile[]) {
    const provider = await this.resolve();
    if (typeof provider.putFiles !== 'function') {
      throw new Error('putFiles is not supported by this sandbox provider');
    }
    return provider.putFiles(files);
  }

  async exportFileToUploadUrl(request: SandboxProviderFileExportRequest) {
    const provider = await this.resolve();
    return provider.exportFileToUploadUrl(request);
  }

  async interrupt(session: SandboxSessionContext): Promise<SandboxInterruptResult> {
    const provider = await this.resolve();
    if (typeof provider.interrupt !== 'function') return { killed: 0 };
    return provider.interrupt(session);
  }

  private async resolve(): Promise<SandboxProvider> {
    const settings = await getEffectiveSandboxSettings();
    switch (settings.provider) {
      case 'local': {
        return getSharedLocalSandboxProvider(settings);
      }
      case 'onlyboxes': {
        return new OnlyboxesSandboxProvider(this.session);
      }
      case 'market': {
        return new MarketSandboxProvider(this.session);
      }
    }
  }
}

const createSandboxProvider = (options: SandboxServiceOptions): SandboxProvider =>
  new DispatchingSandboxProvider(options);

export const createSandboxService = (options: SandboxServiceOptions): SandboxService => {
  return new SandboxMiddlewareService(createSandboxProvider(options), options);
};

/** Test helper. */
export const resetLocalSandboxProviderForTest = (): void => {
  sharedLocalProvider = undefined;
  sharedLocalProviderPromise = undefined;
  sharedLocalFingerprint = undefined;
};
