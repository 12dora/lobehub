// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn().mockResolvedValue(undefined),
  isBootModuleEnabled: vi.fn((_id: string) => false),
  isModuleEnabled: vi.fn(async (_id: string) => false),
}));

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isBootModuleEnabled: (id: string) => mocks.isBootModuleEnabled(id),
  isModuleEnabled: (id: string) => mocks.isModuleEnabled(id),
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: class {
    ensureRunning = mocks.ensureRunning;
  },
}));

vi.mock('../handlers/execAgent', () => ({ execAgent: vi.fn() }));
vi.mock('../handlers/finalizeAbandoned', () => ({ finalizeAbandoned: vi.fn() }));
vi.mock('../handlers/runStep', () => ({ runStep: vi.fn(), runStepHealth: vi.fn() }));
vi.mock('../handlers/toolResult', () => ({ toolResult: vi.fn() }));

describe('POST /api/agent/gateway/start through the Hono app', () => {
  beforeEach(() => {
    mocks.ensureRunning.mockReset().mockResolvedValue(undefined);
    mocks.isBootModuleEnabled.mockReset().mockReturnValue(false);
    mocks.isModuleEnabled.mockReset().mockResolvedValue(false);
    vi.stubEnv('KEY_VAULTS_SECRET', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns HTTP 200 { ok:false, disabled:true } when bots is off', async () => {
    const { default: app } = await import('../index');
    const response = await app.request('/api/agent/gateway/start', {
      body: '{}',
      headers: {
        'Authorization': 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disabled: true, ok: false });
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  }, 30_000);
});
