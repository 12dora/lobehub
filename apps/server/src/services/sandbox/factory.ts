import { sandboxEnv } from '@/envs/sandbox';
import { assertModuleEnabled } from '@/server/enterprise/services/moduleSettings';

import { MarketSandboxProvider } from './providers/market';
import { OnlyboxesSandboxProvider } from './providers/onlyboxes';
import { SandboxMiddlewareService } from './service';
import type {
  LocalSandboxProviderOptions,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderFileExportRequest,
  SandboxProviderKind,
  SandboxService,
  SandboxServiceOptions,
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
  return sandboxEnv.SANDBOX_PROVIDER || 'local';
};

export const getLocalSandboxProviderOptionsFromEnv = (): LocalSandboxProviderOptions => {
  const host = sandboxEnv.SANDBOX_DOCKER_HOST;
  const pullPolicy = sandboxEnv.SANDBOX_LOCAL_PULL_POLICY;

  return {
    host,
    idleTtlSec: sandboxEnv.SANDBOX_LOCAL_IDLE_TTL_SEC,
    image: sandboxEnv.SANDBOX_LOCAL_IMAGE,
    maxContainers: sandboxEnv.SANDBOX_LOCAL_MAX_CONTAINERS,
    maxOutputBytes: sandboxEnv.SANDBOX_LOCAL_MAX_OUTPUT_BYTES,
    memoryBytes: sandboxEnv.SANDBOX_LOCAL_MEMORY_MB * 1024 * 1024,
    nanoCpus: Math.round(sandboxEnv.SANDBOX_LOCAL_CPUS * 1e9),
    network: sandboxEnv.SANDBOX_LOCAL_NETWORK,
    pidsLimit: sandboxEnv.SANDBOX_LOCAL_PIDS_LIMIT,
    pullOnDemand: pullPolicy !== 'never',
    pullPolicy,
    socketPath: sandboxEnv.SANDBOX_DOCKER_SOCKET,
    timeoutMs: sandboxEnv.SANDBOX_LOCAL_TIMEOUT_MS,
  };
};

interface LocalSandboxProviderCtor {
  new (options: LocalSandboxProviderOptions): SandboxProvider;
}

interface LocalSandboxProviderModule {
  LocalSandboxProvider: LocalSandboxProviderCtor;
}

let sharedLocalProvider: SandboxProvider | undefined;
let sharedLocalProviderPromise: Promise<SandboxProvider> | undefined;

/** Dynamic so Market / Onlyboxes and a disabled sandbox module never load the Docker client. */
const loadLocalSandboxProviderModule = async (): Promise<LocalSandboxProviderModule> =>
  import('./providers/local') as Promise<LocalSandboxProviderModule>;

const getSharedLocalSandboxProvider = async (): Promise<SandboxProvider> => {
  await assertModuleEnabled('sandbox');

  if (sharedLocalProvider) return sharedLocalProvider;
  if (sharedLocalProviderPromise) return sharedLocalProviderPromise;

  sharedLocalProviderPromise = loadLocalSandboxProviderModule().then(({ LocalSandboxProvider }) => {
    sharedLocalProvider = new LocalSandboxProvider(getLocalSandboxProviderOptionsFromEnv());
    return sharedLocalProvider;
  });

  try {
    return await sharedLocalProviderPromise;
  } catch (error) {
    sharedLocalProviderPromise = undefined;
    throw error;
  }
};

/**
 * Adapter that is cheap to construct: Docker is imported on first tool call,
 * and only when the enterprise `sandbox` module is enabled.
 */
class GatedLocalSandboxProvider implements SandboxProvider {
  readonly capabilities = LOCAL_SANDBOX_CAPABILITIES;
  readonly kind = 'local';

  async callTool(toolName: string, params: Record<string, unknown>) {
    const provider = await getSharedLocalSandboxProvider();
    return provider.callTool(toolName, params);
  }

  async exportFileToUploadUrl(request: SandboxProviderFileExportRequest) {
    const provider = await getSharedLocalSandboxProvider();
    return provider.exportFileToUploadUrl(request);
  }
}

let gatedLocalProvider: GatedLocalSandboxProvider | undefined;

const getGatedLocalSandboxProvider = (): SandboxProvider => {
  gatedLocalProvider ??= new GatedLocalSandboxProvider();
  return gatedLocalProvider;
};

const createSandboxProvider = (options: SandboxServiceOptions): SandboxProvider => {
  switch (getSandboxProviderKind()) {
    case 'local': {
      return getGatedLocalSandboxProvider();
    }

    case 'onlyboxes': {
      return new OnlyboxesSandboxProvider(options);
    }

    case 'market': {
      return new MarketSandboxProvider(options);
    }
  }
};

export const createSandboxService = (options: SandboxServiceOptions): SandboxService => {
  return new SandboxMiddlewareService(createSandboxProvider(options), options);
};

/** Test helper. */
export const resetLocalSandboxProviderForTest = (): void => {
  gatedLocalProvider = undefined;
  sharedLocalProvider = undefined;
  sharedLocalProviderPromise = undefined;
};
