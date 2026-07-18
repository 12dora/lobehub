/**
 * REWORK-2 regression — direct AiAgentService.execAgent tests for the platform Agent chat entry.
 *
 * Proves the entitlement/authorization boundary, which is resolved BEFORE any runtime work:
 * - the encoded list identity AND a plain local materialized id both re-run beginOperation
 *   (owner-scoped Effective entitlement) exactly once — the client-supplied id is never trusted;
 * - a revoked / unentitled Agent fails closed (NOT_FOUND), never falling through to run the local
 *   row via the ordinary runtime;
 * - the materialized-id reverse lookup is owner-scoped and gated on the managed flag (flag off →
 *   ordinary path, zero platform access);
 * - a fail-closed materialization surfaces a redacted error.
 *
 * @vitest-environment node
 */
import { TRPCError } from '@trpc/server';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';

const {
  beginOperation,
  materializeForOperation,
  getPlatformAgentIdByMaterializedAgentId,
  validateDeps,
} = vi.hoisted(() => ({
  beginOperation: vi.fn(),
  getPlatformAgentIdByMaterializedAgentId: vi.fn(),
  materializeForOperation: vi.fn(),
  validateDeps: vi.fn(async () => ({ valid: true })),
}));

vi.mock('@/server/enterprise/services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentEffectiveResolver: class {
      beginOperation = beginOperation;
    },
    PlatformAgentMaterializationService: class {
      materializeForOperation = materializeForOperation;
    },
    validateExactPlatformAgentDependencies: validateDeps,
  };
});

vi.mock('@/database/repositories/platformAgentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentCatalogRepository: class {
      getPlatformAgentIdByMaterializedAgentId = getPlatformAgentIdByMaterializedAgentId;
    },
  };
});

const { AiAgentService } = await import('../index');
const { PlatformAgentDependencyValidationError, PlatformAgentMaterializationError } =
  await import('@/server/enterprise/services/agentCatalog');

let db: LobeChatDatabase;

const service = () => new AiAgentService(db, 'user-a');

// Spy the ordinary config path so we can prove whether the request went platform or ordinary.
let getAgentConfigSpy: MockInstance;

const run = (params: { agentId?: string; slug?: string }) =>
  service()
    .execAgent({ prompt: 'hi', ...params })
    .then(
      () => null,
      (e) => e,
    );

beforeEach(async () => {
  db = await getTestDB();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  // Ordinary path resolves to "not found" so we can assert reject-early without a real agent row.
  const { AgentService } = await import('@/server/services/agent');
  getAgentConfigSpy = vi.spyOn(AgentService.prototype, 'getAgentConfig').mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const snapshot = {
  checksum: 'a'.repeat(64),
  config: {} as never,
  platformAgentId: 'pagt_1',
  versionId: 'pav_1',
};

describe('AiAgentService.execAgent — platform entitlement (REWORK-2)', () => {
  it('fails closed (NOT_FOUND) for an encoded identity the user is not entitled to', async () => {
    beginOperation.mockResolvedValue(null);
    const error = await run({ agentId: 'platform-agent:pagt_1' });
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    // beginOperation is the authorization boundary — called exactly once, and we never fell through
    // to the ordinary local runtime.
    expect(beginOperation).toHaveBeenCalledTimes(1);
    expect(beginOperation).toHaveBeenCalledWith('user-a', 'pagt_1');
    expect(materializeForOperation).not.toHaveBeenCalled();
    expect(getAgentConfigSpy).not.toHaveBeenCalled();
  });

  it('forces a plain materialized local id back through entitlement and fails closed when revoked', async () => {
    getPlatformAgentIdByMaterializedAgentId.mockResolvedValue('pagt_1');
    beginOperation.mockResolvedValue(null); // assignment revoked
    const error = await run({ agentId: 'agt_localmaterialized' });
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    expect(getPlatformAgentIdByMaterializedAgentId).toHaveBeenCalledWith(
      'user-a',
      'agt_localmaterialized',
    );
    expect(beginOperation).toHaveBeenCalledTimes(1);
    // Never ran the local row as an ordinary agent.
    expect(getAgentConfigSpy).not.toHaveBeenCalled();
  });

  it('does NOT reverse-look-up a local id when the managed flag is off (legacy, zero platform access)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    await run({ agentId: 'agt_localmaterialized' });
    expect(getPlatformAgentIdByMaterializedAgentId).not.toHaveBeenCalled();
    expect(beginOperation).not.toHaveBeenCalled();
    // Falls through to the ordinary agent path.
    expect(getAgentConfigSpy).toHaveBeenCalled();
  });

  it('treats an ordinary (non-materialized) local id as an ordinary agent', async () => {
    getPlatformAgentIdByMaterializedAgentId.mockResolvedValue(null);
    await run({ agentId: 'agt_ordinary' });
    expect(getPlatformAgentIdByMaterializedAgentId).toHaveBeenCalledWith('user-a', 'agt_ordinary');
    expect(beginOperation).not.toHaveBeenCalled();
    expect(getAgentConfigSpy).toHaveBeenCalled();
  });

  it('surfaces a redacted error when materialization fails closed', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => snapshot,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockRejectedValue(new PlatformAgentMaterializationError());
    const error = await run({ agentId: 'platform-agent:pagt_1' });
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    // No SQL / snapshot internals leaked to the public message.
    expect((error as TRPCError).message).toBe('Failed to start platform agent');
    expect(beginOperation).toHaveBeenCalledTimes(1);
  });

  it('fails closed (PRECONDITION_FAILED) when a pinned dependency is unavailable (REWORK-4)', async () => {
    const dependencySnapshot = { connectors: [], model: {}, skills: [] } as never;
    beginOperation.mockResolvedValue({ getSnapshot: () => snapshot, platformAgentId: 'pagt_1' });
    materializeForOperation.mockResolvedValue({
      agentId: 'agt_x',
      config: { id: 'agt_x' },
      dependencySnapshot,
    });
    // The existing M07/M08/M09 exact validator rejects (redacted issue codes only).
    validateDeps.mockRejectedValueOnce(
      new PlatformAgentDependencyValidationError(['SKILL_UNAVAILABLE']),
    );
    const error = await run({ agentId: 'platform-agent:pagt_1' });
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
    // Validation runs against the exact pinned dependency snapshot — no latest fallback.
    expect(validateDeps).toHaveBeenCalledWith(expect.anything(), dependencySnapshot);
    // Public message carries no dependency identifiers / secrets.
    expect((error as TRPCError).message).toBe('Platform agent dependencies are unavailable');
  });
});
