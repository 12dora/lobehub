import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';

const { findPlatformModelPin, initModelRuntimeFromDB, initPlatformExactModelRuntime } = vi.hoisted(
  () => ({
    findPlatformModelPin: vi.fn(),
    initModelRuntimeFromDB: vi.fn(async () => ({ id: 'ordinary-runtime' })),
    initPlatformExactModelRuntime: vi.fn(async () => ({ id: 'exact-runtime' })),
  }),
);

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
}));

vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findPlatformModelPin = findPlatformModelPin;
  },
}));

const { initOperationModelRuntime } = await import('./operationModelRuntime');

const pin = {
  modelKey: 'chat-model',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'internal-provider',
  providerRevision: 1,
};

const ctx = {
  operationId: 'op-1',
  serverDB: {},
  userId: 'user-a',
  workspaceId: undefined,
} as unknown as RuntimeExecutorContext;

beforeEach(() => vi.clearAllMocks());

describe('initOperationModelRuntime (MODEL-EXACT)', () => {
  it('binds the EXACT pinned provider revision when the operation model pin matches the call', async () => {
    findPlatformModelPin.mockResolvedValue(pin);
    const runtime = await initOperationModelRuntime(ctx, 'internal-provider', 'chat-model');

    expect(runtime).toEqual({ id: 'exact-runtime' });
    // The exact historical revision (db, userId, exact ref, workspaceId) — not the latest pointer.
    expect(initPlatformExactModelRuntime).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      pin,
      undefined,
    );
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
  });

  it('uses the ordinary path when the call is for a different provider/model than the pin', async () => {
    findPlatformModelPin.mockResolvedValue(pin);
    await initOperationModelRuntime(ctx, 'other-provider', 'chat-model');
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'other-provider',
      undefined,
    );
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();

    vi.clearAllMocks();
    findPlatformModelPin.mockResolvedValue(pin);
    await initOperationModelRuntime(ctx, 'internal-provider', 'other-model');
    expect(initModelRuntimeFromDB).toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('uses the ordinary path for an operation without a platform model pin (local/builtin)', async () => {
    findPlatformModelPin.mockResolvedValue(null);
    const runtime = await initOperationModelRuntime(ctx, 'openai', 'gpt-4o');
    expect(runtime).toEqual({ id: 'ordinary-runtime' });
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'openai',
      undefined,
    );
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('never reads the pin (or hits exact) when there is no trusted userId', async () => {
    const anonCtx = { ...ctx, userId: undefined } as RuntimeExecutorContext;
    await initOperationModelRuntime(anonCtx, 'openai', 'gpt-4o').catch(() => null);
    expect(findPlatformModelPin).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });
});
