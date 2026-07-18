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
import { fingerprintResumeToolCall } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';

const {
  beginOperation,
  isEntitled,
  materializeForOperation,
  materializeFromPin,
  resolveFromPinForExistingAgent,
  getPlatformAgentIdByMaterializedAgentId,
  validateDeps,
} = vi.hoisted(() => ({
  beginOperation: vi.fn(),
  getPlatformAgentIdByMaterializedAgentId: vi.fn(),
  isEntitled: vi.fn(async () => true),
  materializeForOperation: vi.fn(),
  materializeFromPin: vi.fn(),
  resolveFromPinForExistingAgent: vi.fn(),
  validateDeps: vi.fn(async () => ({ valid: true })),
}));

vi.mock('@/server/enterprise/services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentEffectiveResolver: class {
      beginOperation = beginOperation;
      isEntitled = isEntitled;
    },
    PlatformAgentMaterializationService: class {
      materializeForOperation = materializeForOperation;
      materializeFromPin = materializeFromPin;
      resolveFromPinForExistingAgent = resolveFromPinForExistingAgent;
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

// The resume path resolves the trusted anchor message via MessageModel.findById; stub the model so
// the RR2-1 pin-resolution can be driven deterministically (findById is an instance property, not a
// prototype method, so it can't be vi.spyOn'd). Only findById is exercised before the assertions.
const { messageFindById, messageFindPlugin } = vi.hoisted(() => ({
  messageFindById: vi.fn(),
  messageFindPlugin: vi.fn(),
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    findById = messageFindById;
    findMessagePlugin = messageFindPlugin;
    create = vi.fn(async () => ({ id: 'asst-new' }));
    query = vi.fn(async () => []);
    update = vi.fn(async () => undefined);
    updateMetadata = vi.fn(async () => undefined);
  },
}));

const { AiAgentService } = await import('../index');
const { PlatformAgentDependencyValidationError, PlatformAgentMaterializationError } =
  await import('@/server/enterprise/services/agentCatalog');

let db: LobeChatDatabase;

const service = () => new AiAgentService(db, 'user-a');

// Spy the ordinary config path so we can prove whether the request went platform or ordinary.
let getAgentConfigSpy: MockInstance;
// Spy the EXACT parent-operation pin lookup to drive the resume path.
let findPinSpy: MockInstance;

const run = (params: Record<string, unknown>) =>
  service()
    .execAgent({ prompt: 'hi', ...params } as never)
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
  // Default: no server-bound resumable pin (fresh operation path).
  const { AgentOperationModel } = await import('@/database/models/agentOperation');
  findPinSpy = vi
    .spyOn(AgentOperationModel.prototype, 'findResumablePlatformOperationPin')
    .mockResolvedValue(null);
  // Default: the anchor message exists (owner-scoped); the operation binding drives the resume path.
  messageFindById.mockResolvedValue({ id: 'msg-1', metadata: {}, parentId: 'asst-1' });
  messageFindPlugin.mockResolvedValue({
    apiName: 'deleteRecords',
    arguments: '{"scope":"project"}',
    identifier: 'lobe-database',
    intervention: { kind: 'approval', status: 'pending' },
    toolCallId: 'tc-1',
    type: 'default',
  });
  isEntitled.mockResolvedValue(true);
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

  // RR3-1/RR5-2/RR5-5 resume wiring (unit): ONLY an approval / tool-result body drives a PAUSED
  // resume — it replays the pin of the EXACT parent operation matched by the SERVER-controlled,
  // kind-keyed anchor binding, re-checks LIVE entitlement, and NEVER re-authorizes via beginOperation.
  // A bare regeneration / continue (`parentMessageId` alone) is NOT a paused resume: it starts a fresh
  // operation via beginOperation. (The real forgery-resistance proof lives in the integration test.)
  describe('resume replays the server-bound parent operation pin (RR3-1/RR5-5)', () => {
    const pin = { checksum: 'a'.repeat(64), platformAgentId: 'pagt_1', versionId: 'pav_1' };
    // A PAUSED (approval) resume — the only path that replays the parked pin.
    const resumeParams = {
      agentId: 'platform-agent:pagt_1',
      appContext: { topicId: 'topic-1' },
      parentMessageId: 'msg-1',
      resume: true,
      resumeApproval: {
        decision: 'approved' as const,
        parentMessageId: 'msg-1',
        toolCallId: 'tc-1',
      },
    };
    const okMaterialize = () =>
      materializeFromPin.mockResolvedValue({
        agentId: 'agt_x',
        config: { id: 'agt_x' },
        dependencySnapshot: { connectors: [], model: {}, skills: [] },
      });

    it('resolves via the kind-keyed anchor lookup, re-checks entitlement, no beginOperation', async () => {
      findPinSpy.mockResolvedValue(pin);
      okMaterialize();
      // (execAgent later fails at resume message validation — irrelevant to the pin path we assert.)
      await run(resumeParams);
      // The anchor message is resolved owner-scoped, then the pin is matched by the server-controlled,
      // kind-keyed binding (the approval anchor id), scoped to this platform Agent + topic/thread.
      expect(messageFindById).toHaveBeenCalledWith('msg-1');
      expect(messageFindPlugin).toHaveBeenCalledWith('msg-1');
      const expectedFingerprint = await fingerprintResumeToolCall({
        apiName: 'deleteRecords',
        arguments: '{"scope":"project"}',
        identifier: 'lobe-database',
        toolCallId: 'tc-1',
        type: 'default',
      });
      expect(findPinSpy).toHaveBeenCalledWith({
        anchorKind: 'approval',
        anchorMessageId: 'msg-1',
        fingerprint: expectedFingerprint,
        platformAgentId: 'pagt_1',
        threadId: null,
        toolCallId: 'tc-1',
        topicId: 'topic-1',
      });
      expect(isEntitled).toHaveBeenCalledWith('user-a', 'pagt_1');
      expect(materializeFromPin).toHaveBeenCalledWith(pin);
      expect(beginOperation).not.toHaveBeenCalled();
      expect(validateDeps).toHaveBeenCalled();
    });

    it('RR5-5: a bare parentMessageId (regenerate/continue) starts a fresh operation, not a paused resume', async () => {
      beginOperation.mockResolvedValue({ getSnapshot: () => snapshot, platformAgentId: 'pagt_1' });
      materializeForOperation.mockResolvedValue({
        agentId: 'agt_x',
        config: { id: 'agt_x' },
        dependencySnapshot: { connectors: [], model: {}, skills: [] },
      });
      await run({
        agentId: 'platform-agent:pagt_1',
        appContext: { topicId: 'topic-1' },
        parentMessageId: 'msg-1',
        resume: true,
      });
      // No paused-pin resolution — the generic resume authorizes fresh on CURRENT entitlement.
      expect(findPinSpy).not.toHaveBeenCalled();
      expect(materializeFromPin).not.toHaveBeenCalled();
      expect(beginOperation).toHaveBeenCalledWith('user-a', 'pagt_1');
    });

    it('fails closed when the bound pin is for a different platform Agent', async () => {
      findPinSpy.mockResolvedValue({ ...pin, platformAgentId: 'pagt_OTHER' });
      const error = await run(resumeParams);
      expect((error as TRPCError).code).toBe('NOT_FOUND');
      expect(materializeFromPin).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
    });

    it('fails closed (never a fresh beginOperation) when no bound resumable pin resolves', async () => {
      findPinSpy.mockResolvedValue(null);
      const error = await run(resumeParams);
      expect((error as TRPCError).code).toBe('NOT_FOUND');
      expect(materializeFromPin).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
    });

    it('fails closed when the anchor message is missing (foreign / cross-owner)', async () => {
      messageFindById.mockResolvedValue(undefined as never);
      const error = await run(resumeParams);
      expect((error as TRPCError).code).toBe('NOT_FOUND');
      expect(findPinSpy).not.toHaveBeenCalled();
      expect(materializeFromPin).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
    });

    it('RR3-1: fails closed when live entitlement is revoked (even for a genuinely bound pin)', async () => {
      findPinSpy.mockResolvedValue(pin);
      isEntitled.mockResolvedValue(false);
      okMaterialize();
      const error = await run(resumeParams);
      expect((error as TRPCError).code).toBe('NOT_FOUND');
      // Entitlement is checked BEFORE replaying the pin, so materialize never runs.
      expect(materializeFromPin).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
    });

    it('re-checks live entitlement for a builtin-inbox pin already captured from pending provenance', async () => {
      isEntitled.mockResolvedValue(false);

      const error = await (
        service() as unknown as {
          resolvePlatformAgentConfig: (
            platformAgentId: string,
            identifier: string,
            context: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      )
        .resolvePlatformAgentConfig('pagt_1', 'inbox', {
          capturedResumePin: pin,
          existingAgentId: 'workspace-inbox-id',
          pausedResumeKind: 'approval',
          resumeAnchorMessageId: 'msg-1',
          resumeToolCallId: 'tc-1',
          threadId: null,
          topicId: 'topic-1',
        })
        .then(
          () => null,
          (cause) => cause,
        );

      expect((error as TRPCError).code).toBe('NOT_FOUND');
      expect(isEntitled).toHaveBeenCalledWith('user-a', 'pagt_1');
      expect(resolveFromPinForExistingAgent).not.toHaveBeenCalled();
      expect(beginOperation).not.toHaveBeenCalled();
    });

    it('replays the exact captured old builtin pin when it remains entitled (never latest)', async () => {
      resolveFromPinForExistingAgent.mockResolvedValue({
        agentId: 'workspace-inbox-id',
        config: { id: 'workspace-inbox-id' },
        dependencySnapshot: { connectors: [], model: {}, skills: [] },
      });

      const result = await (
        service() as unknown as {
          resolvePlatformAgentConfig: (
            platformAgentId: string,
            identifier: string,
            context: Record<string, unknown>,
          ) => Promise<{ config: { slug?: string }; pin: typeof pin }>;
        }
      ).resolvePlatformAgentConfig('pagt_1', 'inbox', {
        capturedResumePin: pin,
        existingAgentId: 'workspace-inbox-id',
        pausedResumeKind: 'tool_result',
        resumeAnchorMessageId: 'msg-1',
        resumeToolCallId: 'tc-1',
        threadId: null,
        topicId: 'topic-1',
      });

      expect(isEntitled).toHaveBeenCalledWith('user-a', 'pagt_1');
      expect(resolveFromPinForExistingAgent).toHaveBeenCalledWith(pin, 'workspace-inbox-id');
      expect(result.pin).toBe(pin);
      expect(result.config.slug).toBe('inbox');
      expect(beginOperation).not.toHaveBeenCalled();
    });
  });
});
