import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';

const { findPlatformOperationRef, initModelRuntimeFromDB, initPlatformExactModelRuntime } =
  vi.hoisted(() => ({
    findPlatformOperationRef: vi.fn(),
    initModelRuntimeFromDB: vi.fn(async () => ({ id: 'ordinary-runtime' })),
    initPlatformExactModelRuntime: vi.fn(async () => ({ id: 'exact-runtime' })),
  }));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
}));

vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findPlatformOperationRef = findPlatformOperationRef;
  },
  platformStartBindingsEqual: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

const { initOperationModelRuntime, PlatformExactModelUnavailableError } =
  await import('./operationModelRuntime');

const pin = {
  modelKey: 'chat-model',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'internal-provider',
  providerRevision: 1,
};

const platformStart = {
  assistantMessageId: 'asst-1',
  platformConnectors: [],
  platformModel: pin,
  platformOperation: {
    checksum: 'b'.repeat(64),
    platformAgentId: 'pagt-1',
    versionId: 'pav-1',
  },
  platformSkills: [],
};
const platformRef = {
  classification: 'complete',
  isPlatformOperation: true,
  modelPin: pin,
  platformStart,
};

const ctx = {
  loadAgentState: vi.fn().mockResolvedValue({
    metadata: {
      platformStartBinding: platformStart,
      platformStartClassification: 'complete',
    },
  }),
  operationId: 'op-1',
  serverDB: {},
  userId: 'user-a',
  workspaceId: undefined,
} as unknown as RuntimeExecutorContext;

beforeEach(() => vi.clearAllMocks());

describe('initOperationModelRuntime (MODEL-EXACT + RR2-2)', () => {
  it('binds the EXACT pinned provider revision when a platform op pin matches the call', async () => {
    findPlatformOperationRef.mockResolvedValue(platformRef);
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

  it('RR2-2: a platform op fails closed (no downgrade) when the call provider/model ≠ the pin', async () => {
    findPlatformOperationRef.mockResolvedValue(platformRef);
    await expect(
      initOperationModelRuntime(ctx, 'other-provider', 'chat-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();

    vi.clearAllMocks();
    findPlatformOperationRef.mockResolvedValue(platformRef);
    await expect(
      initOperationModelRuntime(ctx, 'internal-provider', 'other-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('RR2-2: a platform op fails closed when its model pin is missing (never latest)', async () => {
    findPlatformOperationRef.mockResolvedValue({ ...platformRef, modelPin: null });
    await expect(
      initOperationModelRuntime(ctx, 'internal-provider', 'chat-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('uses the ordinary path for a genuinely ordinary operation (no platform marker)', async () => {
    findPlatformOperationRef.mockResolvedValue({
      classification: 'ordinary',
      isPlatformOperation: false,
      modelPin: null,
      platformStart: null,
    });
    const ordinaryCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: { platformStartClassification: 'ordinary' },
      }),
    } as RuntimeExecutorContext;
    const runtime = await initOperationModelRuntime(ordinaryCtx, 'openai', 'gpt-4o');
    expect(runtime).toEqual({ id: 'ordinary-runtime' });
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'openai',
      undefined,
    );
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('uses the ordinary path when the operation row does not exist (builtin/local)', async () => {
    findPlatformOperationRef.mockResolvedValue(null);
    const ordinaryCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: { platformStartClassification: 'ordinary' },
      }),
    } as RuntimeExecutorContext;
    const runtime = await initOperationModelRuntime(ordinaryCtx, 'openai', 'gpt-4o');
    expect(runtime).toEqual({ id: 'ordinary-runtime' });
    expect(initModelRuntimeFromDB).toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('a DB read error propagates (the LLM call fails closed, never guesses)', async () => {
    findPlatformOperationRef.mockRejectedValue(new Error('db down'));
    await expect(initOperationModelRuntime(ctx, 'openai', 'gpt-4o')).rejects.toThrow('db down');
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted runtime classification is missing', async () => {
    findPlatformOperationRef.mockResolvedValue(platformRef);
    const missingStateCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue(null),
    } as RuntimeExecutorContext;
    await expect(
      initOperationModelRuntime(missingStateCtx, 'internal-provider', 'chat-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted binding differs from the persisted complete binding', async () => {
    findPlatformOperationRef.mockResolvedValue(platformRef);
    const mismatchedCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: {
          platformStartBinding: {
            ...platformStart,
            assistantMessageId: 'forged-assistant',
          },
          platformStartClassification: 'complete',
        },
      }),
    } as RuntimeExecutorContext;
    await expect(
      initOperationModelRuntime(mismatchedCtx, 'internal-provider', 'chat-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when an ordinary runtime state unexpectedly carries a platform binding', async () => {
    findPlatformOperationRef.mockResolvedValue({
      classification: 'ordinary',
      isPlatformOperation: false,
      modelPin: null,
      platformStart: null,
    });
    const inconsistentCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: {
          platformStartBinding: platformStart,
          platformStartClassification: 'ordinary',
        },
      }),
    } as RuntimeExecutorContext;

    await expect(initOperationModelRuntime(inconsistentCtx, 'openai', 'chat')).rejects.toThrow(
      'PLATFORM_MODEL_UNAVAILABLE',
    );
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
  });

  it('never reads the ref (or hits exact) when there is no trusted userId', async () => {
    const anonCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        metadata: { platformStartClassification: 'ordinary' },
      }),
      userId: undefined,
    } as RuntimeExecutorContext;
    await initOperationModelRuntime(anonCtx, 'openai', 'gpt-4o');
    expect(findPlatformOperationRef).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });
});
