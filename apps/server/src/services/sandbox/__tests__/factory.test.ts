import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { MarketService } from '@/server/services/market';

const mockAssertModuleEnabled = vi.hoisted(() => vi.fn(async () => undefined));

const LOCAL_CAPABILITIES = {
  backgroundCommands: true,
  exportFile: true,
  files: true,
  languages: ['python', 'javascript', 'typescript'],
  persistentSession: true,
  shell: true,
  skillScripts: true,
};

class MockLocalSandboxProvider {
  static instances: MockLocalSandboxProvider[] = [];
  readonly capabilities = LOCAL_CAPABILITIES;
  readonly kind = 'local' as const;

  constructor(public readonly options: unknown) {
    MockLocalSandboxProvider.instances.push(this);
  }

  callTool = vi.fn(async () => ({ result: { exitCode: 0 }, success: true }));
  exportFileToUploadUrl = vi.fn();
}

vi.mock('../providers/local', () => ({
  LocalSandboxProvider: MockLocalSandboxProvider,
  checkLocalSandboxHealth: vi.fn(),
}));

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  assertModuleEnabled: (...args: unknown[]) => mockAssertModuleEnabled(...args),
}));

const baseOptions = {
  marketService: {} as MarketService,
  topicId: 'topic-1',
  userId: 'user-1',
};

const defaultLocalEnv = {
  SANDBOX_DOCKER_SOCKET: '/var/run/docker.sock',
  SANDBOX_LOCAL_CPUS: 1,
  SANDBOX_LOCAL_IDLE_TTL_SEC: 1800,
  SANDBOX_LOCAL_IMAGE: 'aihub-sandbox:latest',
  SANDBOX_LOCAL_MAX_CONTAINERS: 8,
  SANDBOX_LOCAL_MAX_OUTPUT_BYTES: 1_048_576,
  SANDBOX_LOCAL_MEMORY_MB: 1024,
  SANDBOX_LOCAL_NETWORK: 'bridge' as const,
  SANDBOX_LOCAL_PIDS_LIMIT: 256,
  SANDBOX_LOCAL_PULL_POLICY: 'if-missing' as const,
  SANDBOX_LOCAL_TIMEOUT_MS: 120_000,
};

describe('sandbox service factory', () => {
  beforeEach(() => {
    vi.resetModules();
    MockLocalSandboxProvider.instances = [];
    mockAssertModuleEnabled.mockReset();
    mockAssertModuleEnabled.mockResolvedValue(undefined);
    vi.doMock('../providers/local', () => ({
      LocalSandboxProvider: MockLocalSandboxProvider,
      checkLocalSandboxHealth: vi.fn(),
    }));
    vi.doMock('@/server/enterprise/services/moduleSettings', () => ({
      assertModuleEnabled: (...args: unknown[]) => mockAssertModuleEnabled(...args),
    }));
  });

  it('uses the local provider by default', { timeout: 15_000 }, async () => {
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: defaultLocalEnv,
    }));

    const { createSandboxService, getSandboxProviderKind } = await import('../factory');
    const service = createSandboxService(baseOptions);

    expect(getSandboxProviderKind()).toBe('local');
    expect(service.kind).toBe('local');
    expect(MockLocalSandboxProvider.instances).toHaveLength(0);

    await service.callTool('runCommand', { command: 'true' });

    expect(mockAssertModuleEnabled).toHaveBeenCalledWith('sandbox');
    expect(MockLocalSandboxProvider.instances).toHaveLength(1);
    expect(MockLocalSandboxProvider.instances[0].options).toMatchObject({
      image: 'aihub-sandbox:latest',
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1e9,
      network: 'bridge',
      pullOnDemand: true,
      pullPolicy: 'if-missing',
      socketPath: '/var/run/docker.sock',
    });
    expect(service.capabilities).toMatchObject({
      backgroundCommands: true,
      exportFile: true,
      files: true,
      persistentSession: true,
      shell: true,
      skillScripts: true,
    });
  });

  it('reuses a single LocalSandboxProvider instance per process', { timeout: 15_000 }, async () => {
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: defaultLocalEnv,
    }));

    const { createSandboxService } = await import('../factory');
    const first = createSandboxService(baseOptions);
    const second = createSandboxService({ ...baseOptions, topicId: 'topic-2' });

    await first.callTool('runCommand', { command: 'true' });
    await second.callTool('runCommand', { command: 'true' });

    expect(MockLocalSandboxProvider.instances).toHaveLength(1);
  });

  it('does not construct the Docker provider when the sandbox module is disabled', async () => {
    mockAssertModuleEnabled.mockImplementation(async () => {
      throw new TRPCError({
        cause: {
          data: {
            code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
            details: { moduleId: 'sandbox' },
          },
        },
        code: 'FORBIDDEN',
        message: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      });
    });
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: defaultLocalEnv,
    }));

    const { createSandboxService } = await import('../factory');
    const service = createSandboxService(baseOptions);

    expect(service.kind).toBe('local');
    await expect(service.callTool('runCommand', { command: 'true' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
    });
    expect(MockLocalSandboxProvider.instances).toHaveLength(0);
  });

  it('does not construct the local provider for market', async () => {
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: {
        SANDBOX_PROVIDER: 'market',
      },
    }));

    const { createSandboxService, getSandboxProviderKind } = await import('../factory');
    const service = createSandboxService(baseOptions);

    expect(getSandboxProviderKind()).toBe('market');
    expect(service.kind).toBe('market');
    expect(MockLocalSandboxProvider.instances).toHaveLength(0);
    expect(service.capabilities).toMatchObject({
      backgroundCommands: true,
      exportFile: true,
      files: true,
      persistentSession: true,
      shell: true,
      skillScripts: true,
    });
  });

  it('uses the onlyboxes provider when configured', async () => {
    vi.doMock('@/envs/app', () => ({
      appEnv: {
        APP_URL: 'https://lobehub.example.com',
      },
    }));
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: {
        ONLYBOXES_BASE_URL: 'https://onlyboxes.example.com',
        ONLYBOXES_JIT_SIGNING_KEY: 'jit-signing-key',
        SANDBOX_PROVIDER: 'onlyboxes',
      },
    }));

    const { createSandboxService } = await import('../factory');
    const service = createSandboxService(baseOptions);

    expect(service.kind).toBe('onlyboxes');
    expect(service.capabilities.languages).toEqual(['python', 'javascript', 'typescript']);
    expect(MockLocalSandboxProvider.instances).toHaveLength(0);
  });
});
