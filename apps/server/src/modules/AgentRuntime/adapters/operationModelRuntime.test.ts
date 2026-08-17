import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';

const FIRST_SIGHTING_MS = 1_700_000_000_000;

const {
  findPlatformOperationRef,
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
  rememberConversationStartMs,
} = vi.hoisted(() => ({
  findPlatformOperationRef: vi.fn(),
  initModelRuntimeFromDB: vi.fn(async () => ({ id: 'ordinary-runtime' })),
  initPlatformExactModelRuntime: vi.fn(async () => ({ id: 'exact-runtime' })),
  // The in-process fallback, used only when the operation state has no persisted start.
  rememberConversationStartMs: vi.fn((_key: string) => 1_700_000_000_000),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
  rememberModelRuntimeConversationStartMs: rememberConversationStartMs,
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
      // Every LLM call of one operation is one upstream conversation, and no two
      // operations share one.
      { conversationKey: expect.stringContaining(':operation:'), firstSeenMs: expect.any(Number) },
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
      { conversationKey: expect.stringContaining(':operation:'), firstSeenMs: expect.any(Number) },
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

  it.each([
    [
      'queued',
      {
        classification: 'ordinary',
        isPlatformOperation: false,
        modelPin: null,
        platformStart: null,
      },
    ],
    ['resumed', null],
  ] as const)(
    'keeps an upgrade-era %s ordinary operation on the legacy runtime without saved RR6 proof',
    async (_kind, persistedRef) => {
      findPlatformOperationRef.mockResolvedValue(persistedRef);
      const upgradeCtx = {
        ...ctx,
        loadAgentState: vi.fn().mockResolvedValue({ metadata: {} }),
      } as RuntimeExecutorContext;

      await expect(initOperationModelRuntime(upgradeCtx, 'openai', 'gpt-4o')).resolves.toEqual({
        id: 'ordinary-runtime',
      });
      expect(initModelRuntimeFromDB).toHaveBeenCalled();
      expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
    },
  );

  it('a DB read error propagates (the LLM call fails closed, never guesses)', async () => {
    findPlatformOperationRef.mockRejectedValue(new Error('db down'));
    await expect(initOperationModelRuntime(ctx, 'openai', 'gpt-4o')).rejects.toThrow('db down');
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted runtime classification is missing', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
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
    vi.unstubAllEnvs();
  });

  it('fails closed when saved RR6 proof is missing and the persisted start is partial', async () => {
    findPlatformOperationRef.mockResolvedValue({
      classification: 'partial',
      isPlatformOperation: false,
      modelPin: pin,
      platformStart: null,
    });
    const missingProofCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({ metadata: {} }),
    } as RuntimeExecutorContext;

    await expect(
      initOperationModelRuntime(missingProofCtx, 'internal-provider', 'chat-model'),
    ).rejects.toBeInstanceOf(PlatformExactModelUnavailableError);
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    expect(initPlatformExactModelRuntime).not.toHaveBeenCalled();
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

  it('uses the operation start time persisted in its state as the session start', async () => {
    findPlatformOperationRef.mockResolvedValue(platformRef);
    const startedAt = '2026-08-18T04:05:06.000Z';
    const resumedCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        createdAt: startedAt,
        metadata: {
          platformStartBinding: platformStart,
          platformStartClassification: 'complete',
        },
      }),
    } as RuntimeExecutorContext;

    await initOperationModelRuntime(resumedCtx, 'internal-provider', 'chat-model');

    // Durable: the same operation resumed after an eviction, a restart or on another
    // replica derives the SAME upstream session id, because both halves come from the row.
    expect(initPlatformExactModelRuntime).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      pin,
      undefined,
      {
        conversationKey: 'user:user-a:operation:op-1',
        firstSeenMs: Date.parse(startedAt),
      },
    );
    expect(rememberConversationStartMs).not.toHaveBeenCalled();
  });

  it('falls back to the first sighting only when the state carries no usable start time', async () => {
    findPlatformOperationRef.mockResolvedValue(null);
    const legacyCtx = {
      ...ctx,
      loadAgentState: vi.fn().mockResolvedValue({
        createdAt: 'not-a-timestamp',
        metadata: { platformStartClassification: 'ordinary' },
      }),
    } as RuntimeExecutorContext;

    await initOperationModelRuntime(legacyCtx, 'openai', 'gpt-4o');

    expect(rememberConversationStartMs).toHaveBeenCalledWith('user:user-a:operation:op-1');
    expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'openai',
      undefined,
      { conversationKey: 'user:user-a:operation:op-1', firstSeenMs: FIRST_SIGHTING_MS },
    );
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
