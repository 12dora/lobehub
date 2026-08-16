// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { register } from './instrumentation';

const mocks = vi.hoisted(() => ({
  bootstrapIdentityProviderRuntime: vi.fn().mockResolvedValue(undefined),
  bootstrapPlatformAdminRuntime: vi
    .fn()
    .mockResolvedValue({ reason: 'build-phase', status: 'skipped' }),
  ensurePlatformInstanceHeartbeatStarted: vi.fn().mockResolvedValue(true),
  ensureOperationalMetricsRuntimeStarted: vi.fn().mockResolvedValue(true),
  gatewayEnsureRunning: vi.fn().mockResolvedValue(undefined),
  registerTelemetry: vi.fn(),
  /** Set to simulate the startup-bootstrap module failing to evaluate at import time. */
  startupModuleLoadError: { value: null as Error | null },
}));

vi.mock('@/server/enterprise/bootstrap/startupBootstrap', () => ({
  // A getter so a test can make the import/destructure boundary itself fail, the way
  // a module-evaluation error in `startupBootstrap` (or its env-backed imports) would.
  get bootstrapPlatformAdminRuntime() {
    if (mocks.startupModuleLoadError.value) throw mocks.startupModuleLoadError.value;
    return mocks.bootstrapPlatformAdminRuntime;
  },
}));
vi.mock('@/server/enterprise/services/identityProvider/bootstrap', () => ({
  bootstrapIdentityProviderRuntime: mocks.bootstrapIdentityProviderRuntime,
}));
vi.mock('@/server/enterprise/services/platformInstance/heartbeatRuntime', () => ({
  ensurePlatformInstanceHeartbeatStarted: mocks.ensurePlatformInstanceHeartbeatStarted,
}));
vi.mock('@/server/enterprise/services/platformObservability/operationalMetricsRuntime', () => ({
  ensureOperationalMetricsRuntimeStarted: mocks.ensureOperationalMetricsRuntimeStarted,
}));
// Real module: pulls in the whole database/env graph and instantiates a live gateway.
// Left unmocked, this suite's runtime depended on whether DATABASE_URL happened to be
// present in the ambient environment — fast in isolation, multi-second (or throwing) in
// a full-tree run. Mock it so `register()` is deterministic and cheap either way.
vi.mock('@/server/services/gateway', () => ({
  GatewayService: class {
    ensureRunning = mocks.gatewayEnsureRunning;
  },
}));
vi.mock('./instrumentation.node', () => {
  mocks.registerTelemetry();
  return {};
});

beforeEach(() => {
  // Pin every branch input `register()` reads, so no test inherits ambient env.
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('ENABLE_BOT_IN_DEV', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('instrumentation platform instance bootstrap', () => {
  it('dynamically ensures the heartbeat runtime on Node', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');

    await register();

    expect(mocks.bootstrapPlatformAdminRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIdentityProviderRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePlatformInstanceHeartbeatStarted).toHaveBeenCalledTimes(1);
    // No DATABASE_URL → the gateway branch must stay untouched.
    expect(mocks.gatewayEnsureRunning).not.toHaveBeenCalled();
  });

  it('auto-starts the agent gateway when a database is configured', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');

    await register();

    expect(mocks.gatewayEnsureRunning).toHaveBeenCalledTimes(1);
  });

  it('keeps booting when the platform admin bootstrap rejects', async () => {
    // Next awaits register() before serving traffic — a bootstrap failure must not
    // take the server down, and must not skip the identity/heartbeat runtimes.
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.bootstrapPlatformAdminRuntime.mockRejectedValueOnce(
      new Error('PLATFORM_MASTER_KEY must be base64 of exactly 32 bytes'),
    );

    await expect(register()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[Instrumentation] platform admin bootstrap unavailable (non-blocking)',
      { errorClass: 'Error' },
    );
    // The sanitized log must not leak the underlying message.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('PLATFORM_MASTER_KEY');
    expect(mocks.bootstrapIdentityProviderRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePlatformInstanceHeartbeatStarted).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('keeps booting when loading the startup bootstrap module fails', async () => {
    // `startupBootstrap` statically imports env-backed modules; a module-evaluation
    // failure surfaces at the import boundary, before the module's own guard can run.
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.startupModuleLoadError.value = new Error('AUTH_SECRET is required');

    try {
      await expect(register()).resolves.toBeUndefined();

      expect(mocks.bootstrapPlatformAdminRuntime).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[Instrumentation] platform admin bootstrap unavailable (non-blocking)',
        { errorClass: 'Error' },
      );
      expect(mocks.bootstrapIdentityProviderRuntime).toHaveBeenCalledTimes(1);
      expect(mocks.ensurePlatformInstanceHeartbeatStarted).toHaveBeenCalledTimes(1);
    } finally {
      mocks.startupModuleLoadError.value = null;
      errorSpy.mockRestore();
    }
  });

  it('does not bootstrap persistent runtimes on edge', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');

    await register();

    expect(mocks.bootstrapPlatformAdminRuntime).not.toHaveBeenCalled();
    expect(mocks.bootstrapIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(mocks.ensurePlatformInstanceHeartbeatStarted).not.toHaveBeenCalled();
  });

  it('starts operational collection only after the Node telemetry provider is registered', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '1');

    await register();

    expect(mocks.registerTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.ensureOperationalMetricsRuntimeStarted).toHaveBeenCalledTimes(1);
    expect(mocks.registerTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureOperationalMetricsRuntimeStarted.mock.invocationCallOrder[0]!,
    );
  });
});
