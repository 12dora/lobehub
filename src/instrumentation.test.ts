// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { register } from './instrumentation';

const mocks = vi.hoisted(() => ({
  bootstrapIdentityProviderRuntime: vi.fn().mockResolvedValue(undefined),
  ensurePlatformInstanceHeartbeatStarted: vi.fn().mockResolvedValue(true),
  ensureOperationalMetricsRuntimeStarted: vi.fn().mockResolvedValue(true),
  registerTelemetry: vi.fn(),
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
vi.mock('./instrumentation.node', () => {
  mocks.registerTelemetry();
  return {};
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

    expect(mocks.bootstrapIdentityProviderRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePlatformInstanceHeartbeatStarted).toHaveBeenCalledTimes(1);
  });

  it('does not bootstrap persistent runtimes on edge', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_TELEMETRY', '');

    await register();

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
