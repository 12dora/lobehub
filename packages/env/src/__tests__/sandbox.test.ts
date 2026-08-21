// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOCAL_ENV_KEYS = [
  'SANDBOX_DOCKER_HOST',
  'SANDBOX_DOCKER_SOCKET',
  'SANDBOX_LOCAL_CPUS',
  'SANDBOX_LOCAL_IDLE_TTL_SEC',
  'SANDBOX_LOCAL_IMAGE',
  'SANDBOX_LOCAL_MAX_CONTAINERS',
  'SANDBOX_LOCAL_MAX_OUTPUT_BYTES',
  'SANDBOX_LOCAL_MEMORY_MB',
  'SANDBOX_LOCAL_NETWORK',
  'SANDBOX_LOCAL_PIDS_LIMIT',
  'SANDBOX_LOCAL_PULL_POLICY',
  'SANDBOX_LOCAL_TIMEOUT_MS',
] as const;

describe('getSandboxConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SANDBOX_PROVIDER;
    delete process.env.ONLYBOXES_BASE_URL;
    delete process.env.ONLYBOXES_JIT_ISSUER;
    delete process.env.ONLYBOXES_JIT_SIGNING_KEY;
    delete process.env.ONLYBOXES_JIT_TTL_SEC;
    delete process.env.ONLYBOXES_LEASE_TTL_SEC;
    for (const key of LOCAL_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('should treat docker empty string defaults as unset optional values', async () => {
    process.env.SANDBOX_PROVIDER = '';
    process.env.ONLYBOXES_BASE_URL = '';
    process.env.ONLYBOXES_JIT_ISSUER = '';
    process.env.ONLYBOXES_JIT_SIGNING_KEY = '';
    process.env.ONLYBOXES_JIT_TTL_SEC = '';
    process.env.ONLYBOXES_LEASE_TTL_SEC = '';
    process.env.SANDBOX_DOCKER_HOST = '';
    process.env.SANDBOX_DOCKER_SOCKET = '';
    process.env.SANDBOX_LOCAL_IMAGE = '';
    process.env.SANDBOX_LOCAL_PULL_POLICY = '';
    process.env.SANDBOX_LOCAL_NETWORK = '';
    process.env.SANDBOX_LOCAL_MEMORY_MB = '';
    process.env.SANDBOX_LOCAL_PIDS_LIMIT = '';
    process.env.SANDBOX_LOCAL_CPUS = '';
    process.env.SANDBOX_LOCAL_TIMEOUT_MS = '';
    process.env.SANDBOX_LOCAL_MAX_OUTPUT_BYTES = '';
    process.env.SANDBOX_LOCAL_IDLE_TTL_SEC = '';
    process.env.SANDBOX_LOCAL_MAX_CONTAINERS = '';

    const { getSandboxConfig } = await import('../sandbox');
    const config = getSandboxConfig();

    expect(config.SANDBOX_PROVIDER).toBe('local');
    expect(config.ONLYBOXES_BASE_URL).toBeUndefined();
    expect(config.ONLYBOXES_JIT_ISSUER).toBeUndefined();
    expect(config.ONLYBOXES_JIT_SIGNING_KEY).toBeUndefined();
    expect(config.ONLYBOXES_JIT_TTL_SEC).toBeUndefined();
    expect(config.ONLYBOXES_LEASE_TTL_SEC).toBeUndefined();
    expect(config.SANDBOX_DOCKER_HOST).toBeUndefined();
    expect(config.SANDBOX_DOCKER_SOCKET).toBe('/var/run/docker.sock');
    expect(config.SANDBOX_LOCAL_IMAGE).toBe('aihub-sandbox:latest');
    expect(config.SANDBOX_LOCAL_PULL_POLICY).toBe('if-missing');
    expect(config.SANDBOX_LOCAL_NETWORK).toBe('bridge');
    expect(config.SANDBOX_LOCAL_MEMORY_MB).toBe(1024);
    expect(config.SANDBOX_LOCAL_PIDS_LIMIT).toBe(256);
    expect(config.SANDBOX_LOCAL_CPUS).toBe(1);
    expect(config.SANDBOX_LOCAL_TIMEOUT_MS).toBe(120_000);
    expect(config.SANDBOX_LOCAL_MAX_OUTPUT_BYTES).toBe(1_048_576);
    expect(config.SANDBOX_LOCAL_IDLE_TTL_SEC).toBe(1800);
    expect(config.SANDBOX_LOCAL_MAX_CONTAINERS).toBe(8);
  });

  it('defaults SANDBOX_PROVIDER to local when unset', async () => {
    const { getSandboxConfig } = await import('../sandbox');
    const config = getSandboxConfig();

    expect(config.SANDBOX_PROVIDER).toBe('local');
  });

  it('should parse configured sandbox values', async () => {
    process.env.SANDBOX_PROVIDER = 'onlyboxes';
    process.env.ONLYBOXES_BASE_URL = 'https://onlyboxes.example.com';
    process.env.ONLYBOXES_JIT_ISSUER = 'lobehub-test';
    process.env.ONLYBOXES_JIT_SIGNING_KEY = 'jit-signing-key';
    process.env.ONLYBOXES_JIT_TTL_SEC = '900';
    process.env.ONLYBOXES_LEASE_TTL_SEC = '3600';

    const { getSandboxConfig } = await import('../sandbox');
    const config = getSandboxConfig();

    expect(config.SANDBOX_PROVIDER).toBe('onlyboxes');
    expect(config.ONLYBOXES_BASE_URL).toBe('https://onlyboxes.example.com');
    expect(config.ONLYBOXES_JIT_ISSUER).toBe('lobehub-test');
    expect(config.ONLYBOXES_JIT_SIGNING_KEY).toBe('jit-signing-key');
    expect(config.ONLYBOXES_JIT_TTL_SEC).toBe(900);
    expect(config.ONLYBOXES_LEASE_TTL_SEC).toBe(3600);
  });

  it('parses local Docker sandbox configuration', async () => {
    process.env.SANDBOX_PROVIDER = 'local';
    process.env.SANDBOX_DOCKER_SOCKET = '/custom/docker.sock';
    process.env.SANDBOX_DOCKER_HOST = 'tcp://127.0.0.1:2375';
    process.env.SANDBOX_LOCAL_IMAGE = 'aihub-sandbox:1.2.3';
    process.env.SANDBOX_LOCAL_PULL_POLICY = 'never';
    process.env.SANDBOX_LOCAL_NETWORK = 'none';
    process.env.SANDBOX_LOCAL_MEMORY_MB = '512';
    process.env.SANDBOX_LOCAL_PIDS_LIMIT = '128';
    process.env.SANDBOX_LOCAL_CPUS = '0.5';
    process.env.SANDBOX_LOCAL_TIMEOUT_MS = '30000';
    process.env.SANDBOX_LOCAL_MAX_OUTPUT_BYTES = '4096';
    process.env.SANDBOX_LOCAL_IDLE_TTL_SEC = '60';
    process.env.SANDBOX_LOCAL_MAX_CONTAINERS = '2';

    const { getSandboxConfig } = await import('../sandbox');
    const config = getSandboxConfig();

    expect(config.SANDBOX_PROVIDER).toBe('local');
    expect(config.SANDBOX_DOCKER_SOCKET).toBe('/custom/docker.sock');
    expect(config.SANDBOX_DOCKER_HOST).toBe('tcp://127.0.0.1:2375');
    expect(config.SANDBOX_LOCAL_IMAGE).toBe('aihub-sandbox:1.2.3');
    expect(config.SANDBOX_LOCAL_PULL_POLICY).toBe('never');
    expect(config.SANDBOX_LOCAL_NETWORK).toBe('none');
    expect(config.SANDBOX_LOCAL_MEMORY_MB).toBe(512);
    expect(config.SANDBOX_LOCAL_PIDS_LIMIT).toBe(128);
    expect(config.SANDBOX_LOCAL_CPUS).toBe(0.5);
    expect(config.SANDBOX_LOCAL_TIMEOUT_MS).toBe(30_000);
    expect(config.SANDBOX_LOCAL_MAX_OUTPUT_BYTES).toBe(4096);
    expect(config.SANDBOX_LOCAL_IDLE_TTL_SEC).toBe(60);
    expect(config.SANDBOX_LOCAL_MAX_CONTAINERS).toBe(2);
  });

  it('rejects an unknown SANDBOX_PROVIDER', async () => {
    process.env.SANDBOX_PROVIDER = 'e2b';

    await expect(import('../sandbox')).rejects.toThrow(/Invalid environment variables/);
  });
});
