// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayStart } from '../gatewayStart';

const { mockEnsureRunning, mockIsBootModuleEnabled, mockStop } = vi.hoisted(() => ({
  mockEnsureRunning: vi.fn(),
  mockIsBootModuleEnabled: vi.fn((_id: string) => true),
  mockStop: vi.fn(),
}));

vi.mock('@/server/enterprise/services/moduleSettings', () => ({
  isBootModuleEnabled: (id: string) => mockIsBootModuleEnabled(id),
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: vi.fn().mockImplementation(() => ({
    ensureRunning: mockEnsureRunning,
    stop: mockStop,
  })),
}));

function buildContext(opts: { body?: unknown; jsonThrows?: boolean }) {
  const captures: Array<{ body: any; status: number }> = [];
  const ctx = {
    json: (b: any, status = 200) => {
      captures.push({ body: b, status });
      return Response.json(b, { status });
    },
    req: {
      json: opts.jsonThrows
        ? async () => {
            throw new Error('bad json');
          }
        : async () => opts.body,
    },
  } as any;
  return { ctx, getCaptures: () => captures };
}

describe('gatewayStart handler', () => {
  beforeEach(() => {
    mockEnsureRunning.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
    mockIsBootModuleEnabled.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns status="started" and only calls ensureRunning when restart is falsy', async () => {
    const { ctx, getCaptures } = buildContext({ body: {} });
    const res = await gatewayStart(ctx);

    expect(res.status).toBe(200);
    expect(getCaptures()[0].body).toEqual({ status: 'started' });
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockEnsureRunning).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed JSON body as empty {} and starts the gateway', async () => {
    const { ctx, getCaptures } = buildContext({ jsonThrows: true });
    const res = await gatewayStart(ctx);

    expect(res.status).toBe(200);
    expect(getCaptures()[0].body).toEqual({ status: 'started' });
    expect(mockEnsureRunning).toHaveBeenCalledTimes(1);
  });

  it('stops then ensures running when restart=true and reports "restarted"', async () => {
    const { ctx, getCaptures } = buildContext({ body: { restart: true } });
    const res = await gatewayStart(ctx);

    expect(res.status).toBe(200);
    expect(getCaptures()[0].body).toEqual({ status: 'restarted' });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockEnsureRunning).toHaveBeenCalledTimes(1);
    // stop must be called before ensureRunning
    expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsureRunning.mock.invocationCallOrder[0],
    );
  });

  it('returns HTTP 200 { ok:false, disabled:true } when bots is off', async () => {
    mockIsBootModuleEnabled.mockReturnValue(false);
    const { ctx, getCaptures } = buildContext({ body: {} });
    const res = await gatewayStart(ctx);

    expect(res.status).toBe(200);
    expect(getCaptures()[0].body).toEqual({ disabled: true, ok: false });
    expect(mockEnsureRunning).not.toHaveBeenCalled();
    expect(mockIsBootModuleEnabled).toHaveBeenCalledWith('bots');
  });

  it('returns 500 when ensureRunning throws', async () => {
    mockEnsureRunning.mockRejectedValue(new Error('boom'));
    const { ctx, getCaptures } = buildContext({ body: {} });

    const res = await gatewayStart(ctx);

    expect(res.status).toBe(500);
    expect(getCaptures()[0].body).toEqual({ error: 'Failed to start gateway' });
  });
});
