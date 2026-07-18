// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agentOperations, threads, topics, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { AgentOperationModel } from '../agentOperation';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'agent-operation-test-user-id';
const otherUserId = 'agent-operation-test-other-user';

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

afterEach(async () => {
  await serverDB.delete(agentOperations);
  await serverDB.delete(users);
});

describe('AgentOperationModel', () => {
  describe('recordStart', () => {
    it('inserts a row with status=running and the provided ids', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-start-1';

      await model.recordStart({
        appContext: { scope: 'chat', sourceMessageId: 'msg-1' },
        maxSteps: 20,
        model: 'gpt-4o',
        modelRuntimeConfig: { model: 'gpt-4o', provider: 'openai' },
        operationId,
        provider: 'openai',
        trigger: 'chat',
      });

      const row = await model.findById(operationId);
      expect(row).toMatchObject({
        appContext: { scope: 'chat', sourceMessageId: 'msg-1' },
        id: operationId,
        maxSteps: 20,
        model: 'gpt-4o',
        modelRuntimeConfig: { model: 'gpt-4o', provider: 'openai' },
        provider: 'openai',
        status: 'running',
        trigger: 'chat',
        userId,
      });
      expect(row?.startedAt).toBeInstanceOf(Date);
      expect(row?.completedAt).toBeNull();
    });

    it('persists the agent-signal marker into metadata so server tools can read it back', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-start-marker';
      // Server-side self-iteration tools resolve the review window / source id from
      // metadata.agentSignal (the trimmed appContext intentionally drops it). If
      // the marker is not persisted here, tools fall back to a 1970 window +
      // operationId source.
      const agentSignal = {
        agentId: 'agent_reviewed',
        kind: 'nightly-review',
        localDate: '2026-05-30',
        reviewWindowEnd: '2026-05-30T00:00:00.000Z',
        reviewWindowStart: '2026-05-29T00:00:00.000Z',
        sourceId: 'nightly-review:user:agent_reviewed:2026-05-30',
      };

      await model.recordStart({
        appContext: { scope: 'chat' },
        metadata: { agentSignal },
        operationId,
      });

      const row = await model.findById(operationId);
      expect(row?.metadata).toEqual({ agentSignal });
    });

    it('is idempotent on the primary key', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-start-2';

      await model.recordStart({ operationId });
      // Second call must not throw — primary-key conflict is swallowed.
      await model.recordStart({ operationId });

      const rows = await serverDB
        .select()
        .from(agentOperations)
        .where(eq(agentOperations.id, operationId));
      expect(rows).toHaveLength(1);
    });
  });

  describe('recordCompletion', () => {
    it('updates the row to a terminal status with aggregates and trace key', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-complete-1';

      const completedAt = new Date('2026-05-13T01:23:45.000Z');
      await model.recordStart({ operationId });
      await model.recordCompletion(operationId, {
        completedAt,
        completionReason: 'done',
        cost: { total: 0.123 },
        llmCalls: 4,
        processingTimeMs: 5432,
        status: 'done',
        stepCount: 7,
        toolCalls: 2,
        totalCost: 0.123,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalTokens: 1200,
        traceS3Key: 'agent-traces/agent-x/topic-x/op-complete-1.json',
        usage: { llm: { apiCalls: 4 } },
      });

      const row = await model.findById(operationId);
      expect(row).toMatchObject({
        completionReason: 'done',
        cost: { total: 0.123 },
        llmCalls: 4,
        processingTimeMs: 5432,
        status: 'done',
        stepCount: 7,
        toolCalls: 2,
        totalCost: 0.123,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalTokens: 1200,
        traceS3Key: 'agent-traces/agent-x/topic-x/op-complete-1.json',
      });
      expect(row?.completedAt?.toISOString()).toBe(completedAt.toISOString());
    });

    it('leaves completedAt null when not explicitly provided (e.g. waiting_for_human)', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-waiting';

      await model.recordStart({ operationId });
      await model.recordCompletion(operationId, {
        completionReason: 'waiting_for_human',
        status: 'waiting_for_human',
      });

      const row = await model.findById(operationId);
      expect(row?.status).toBe('waiting_for_human');
      expect(row?.completedAt).toBeNull();
    });

    it('writes error and interruption payloads on failure paths', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      const operationId = 'op-complete-error';

      await model.recordStart({ operationId });
      await model.recordCompletion(operationId, {
        completedAt: new Date(),
        completionReason: 'error',
        error: { message: 'boom', type: 'AgentRuntimeError' },
        interruption: {
          canResume: false,
          interruptedAt: '2026-05-13T00:00:00.000Z',
          reason: 'rate_limited',
        },
        status: 'error',
      });

      const row = await model.findById(operationId);
      expect(row?.status).toBe('error');
      expect(row?.completionReason).toBe('error');
      expect(row?.error).toMatchObject({ message: 'boom', type: 'AgentRuntimeError' });
      expect(row?.interruption).toMatchObject({ canResume: false, reason: 'rate_limited' });
    });

    it('is a no-op when the start row was never written', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      // No prior recordStart — recordCompletion must not throw and must not
      // create a phantom row.
      await model.recordCompletion('op-missing', { status: 'done', completionReason: 'done' });

      const row = await model.findById('op-missing');
      expect(row).toBeNull();
    });

    it('does not flip another user’s row when their operationId is known', async () => {
      const ownerModel = new AgentOperationModel(serverDB, userId);
      const attackerModel = new AgentOperationModel(serverDB, otherUserId);
      const operationId = 'op-cross-user';

      await ownerModel.recordStart({ operationId });
      await attackerModel.recordCompletion(operationId, {
        completedAt: new Date(),
        completionReason: 'error',
        error: { message: 'spoofed', type: 'AgentRuntimeError' },
        status: 'error',
      });

      // Owner's row must still read as running — the cross-user update is
      // filtered out by the userId scope in the WHERE clause.
      const row = await ownerModel.findById(operationId);
      expect(row?.status).toBe('running');
      expect(row?.error).toBeNull();
      // The attacker cannot read the row either.
      expect(await attackerModel.findById(operationId)).toBeNull();
    });
  });

  describe('getMaxDurationSeconds', () => {
    it('returns the longest wall-clock duration, ignoring in-flight and other users', async () => {
      const model = new AgentOperationModel(serverDB, userId);

      await serverDB.insert(agentOperations).values([
        // 5 minutes
        {
          completedAt: new Date('2026-05-13T10:05:00.000Z'),
          id: 'op-dur-1',
          startedAt: new Date('2026-05-13T10:00:00.000Z'),
          status: 'done',
          userId,
        },
        // 1 hour — the longest
        {
          completedAt: new Date('2026-05-13T12:00:00.000Z'),
          id: 'op-dur-2',
          startedAt: new Date('2026-05-13T11:00:00.000Z'),
          status: 'done',
          userId,
        },
        // in-flight: no completedAt -> excluded
        {
          completedAt: null,
          id: 'op-dur-running',
          startedAt: new Date('2026-05-13T09:00:00.000Z'),
          status: 'running',
          userId,
        },
        // another user's much longer op -> excluded
        {
          completedAt: new Date('2026-05-13T20:00:00.000Z'),
          id: 'op-dur-other',
          startedAt: new Date('2026-05-13T10:00:00.000Z'),
          status: 'done',
          userId: otherUserId,
        },
      ]);

      const result = await model.getMaxDurationSeconds();
      expect(result).toBe(3600);
    });

    it('returns 0 when there are no completed operations', async () => {
      const model = new AgentOperationModel(serverDB, userId);

      await serverDB.insert(agentOperations).values({
        completedAt: null,
        id: 'op-dur-none',
        startedAt: new Date('2026-05-13T09:00:00.000Z'),
        status: 'running',
        userId,
      });

      const result = await model.getMaxDurationSeconds();
      expect(result).toBe(0);
    });
  });

  describe('findResumablePlatformOperationPin (RR4-1)', () => {
    const pin = { checksum: 'a'.repeat(64), platformAgentId: 'pagt_1', versionId: 'pav_1' };
    const modelPin = {
      modelKey: 'chat',
      providerChecksum: 'b'.repeat(64),
      providerKey: 'openai',
      providerRevision: 1,
    };

    beforeEach(async () => {
      await serverDB.insert(topics).values([
        { id: 'topic-1', userId },
        { id: 'topic-2', userId },
      ]);
      await serverDB
        .insert(threads)
        .values([{ id: 'thread-1', topicId: 'topic-1', type: 'standalone', userId }]);
    });

    // Seed an operation row directly (server-controlled) with the resume-anchor binding + status.
    const seedOp = (params: {
      assistantMessageId?: string;
      id: string;
      ownerId?: string;
      pendingResumeAnchorIds?: string[];
      platformAgentId?: string;
      status?: 'waiting_for_human' | 'waiting_for_async_tool' | 'done';
      threadId?: string | null;
      topicId?: string;
    }) =>
      serverDB.insert(agentOperations).values({
        id: params.id,
        metadata: {
          ...(params.assistantMessageId ? { assistantMessageId: params.assistantMessageId } : {}),
          ...(params.pendingResumeAnchorIds
            ? { pendingResumeAnchorIds: params.pendingResumeAnchorIds }
            : {}),
          platformModel: modelPin,
          platformOperation: { ...pin, platformAgentId: params.platformAgentId ?? 'pagt_1' },
        },
        startedAt: new Date(),
        status: params.status ?? 'waiting_for_human',
        threadId: params.threadId ?? null,
        topicId: params.topicId ?? 'topic-1',
        userId: params.ownerId ?? userId,
      });

    const find = (
      model: AgentOperationModel,
      params: {
        anchorKind?: 'assistant' | 'tool';
        anchorMessageId: string;
        platformAgentId?: string;
        threadId?: string | null;
        topicId?: string | null;
      },
    ) =>
      model.findResumablePlatformOperationPin({
        anchorKind: params.anchorKind ?? 'assistant',
        anchorMessageId: params.anchorMessageId,
        platformAgentId: params.platformAgentId ?? 'pagt_1',
        threadId: params.threadId ?? null,
        topicId: params.topicId === undefined ? 'topic-1' : params.topicId,
      });

    const model = () => new AgentOperationModel(serverDB, userId);

    it('direct resume resolves via the EXACT server-recorded assistant id', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1' });
      expect(await find(model(), { anchorKind: 'assistant', anchorMessageId: 'asst-1' })).toEqual(
        pin,
      );
    });

    it('tool resume resolves via an EXACT server-recorded pending tool id — a forged tool never binds', async () => {
      await seedOp({
        assistantMessageId: 'asst-1',
        id: 'op-1',
        pendingResumeAnchorIds: ['tool-1', 'tool-2'],
      });
      expect(await find(model(), { anchorKind: 'tool', anchorMessageId: 'tool-2' })).toEqual(pin);
      // A client-forged tool message (e.g. parentId spoofed to asst-1) whose id is NOT among the
      // server-recorded pending tool ids can never bind.
      expect(
        await find(model(), { anchorKind: 'tool', anchorMessageId: 'forged-tool' }),
      ).toBeNull();
    });

    it('kind crossing fails: assistant id as a tool anchor (and vice versa) never matches', async () => {
      await seedOp({
        assistantMessageId: 'asst-1',
        id: 'op-1',
        pendingResumeAnchorIds: ['tool-1'],
      });
      expect(await find(model(), { anchorKind: 'tool', anchorMessageId: 'asst-1' })).toBeNull();
      expect(
        await find(model(), { anchorKind: 'assistant', anchorMessageId: 'tool-1' }),
      ).toBeNull();
    });

    it('fails closed for a fabricated anchor bound to no operation', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1' });
      expect(await find(model(), { anchorMessageId: 'forged' })).toBeNull();
    });

    it('is owner-scoped: another user cannot bind to this operation', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1' });
      expect(
        await find(new AgentOperationModel(serverDB, otherUserId), { anchorMessageId: 'asst-1' }),
      ).toBeNull();
    });

    it('binds topic and thread exactly, and requires a topic', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1', threadId: 'thread-1' });
      expect(await find(model(), { anchorMessageId: 'asst-1', threadId: 'thread-1' })).toEqual(pin);
      expect(await find(model(), { anchorMessageId: 'asst-1', threadId: null })).toBeNull();
      expect(
        await find(model(), {
          anchorMessageId: 'asst-1',
          threadId: 'thread-1',
          topicId: 'topic-2',
        }),
      ).toBeNull();
      expect(
        await find(model(), { anchorMessageId: 'asst-1', threadId: 'thread-1', topicId: null }),
      ).toBeNull();
    });

    it('RR4-2: only waiting_for_human is externally resumable (async-tool + terminal excluded)', async () => {
      await seedOp({
        assistantMessageId: 'asst-async',
        id: 'op-async',
        status: 'waiting_for_async_tool',
      });
      await seedOp({ assistantMessageId: 'asst-done', id: 'op-done', status: 'done' });
      expect(await find(model(), { anchorMessageId: 'asst-async' })).toBeNull();
      expect(await find(model(), { anchorMessageId: 'asst-done' })).toBeNull();
    });

    it('binds the requested platform Agent', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1', platformAgentId: 'pagt_OTHER' });
      expect(
        await find(model(), { anchorMessageId: 'asst-1', platformAgentId: 'pagt_1' }),
      ).toBeNull();
      expect(
        await find(model(), { anchorMessageId: 'asst-1', platformAgentId: 'pagt_OTHER' }),
      ).toEqual({ ...pin, platformAgentId: 'pagt_OTHER' });
    });

    it('recordResumeAnchors records the server-owned pending tool ids (owner-scoped)', async () => {
      await seedOp({ assistantMessageId: 'asst-1', id: 'op-1' });
      await model().recordResumeAnchors('op-1', ['tool-a', 'tool-b']);
      expect(await find(model(), { anchorKind: 'tool', anchorMessageId: 'tool-b' })).toEqual(pin);
      // Another owner can't write anchors onto this op.
      await new AgentOperationModel(serverDB, otherUserId).recordResumeAnchors('op-1', ['tool-x']);
      expect(await find(model(), { anchorKind: 'tool', anchorMessageId: 'tool-x' })).toBeNull();
    });

    describe('findPlatformOperationRef (RR2-2)', () => {
      // Direct insert (not recordStart) so the classification test can seed a platform row without
      // satisfying the full RR4-3 start-completeness gate.
      const seedRef = (id: string, platform: boolean) =>
        serverDB.insert(agentOperations).values({
          id,
          metadata: platform ? { platformModel: modelPin, platformOperation: pin } : {},
          startedAt: new Date(),
          status: 'running',
          topicId: 'topic-1',
          userId,
        });

      it('classifies a platform operation and returns its model pin', async () => {
        await seedRef('op-platform', true);
        expect(await model().findPlatformOperationRef('op-platform')).toEqual({
          isPlatformOperation: true,
          modelPin,
        });
      });

      it('classifies an ordinary operation (no marker, no pin)', async () => {
        await seedRef('op-ordinary', false);
        expect(await model().findPlatformOperationRef('op-ordinary')).toEqual({
          isPlatformOperation: false,
          modelPin: null,
        });
      });

      it('returns null when the operation row does not exist under this owner scope', async () => {
        expect(await model().findPlatformOperationRef('op-missing')).toBeNull();
      });
    });
  });

  describe('recordStart — platform start exact binding + conflict (RR4-3/RR4-4)', () => {
    const pin = { checksum: 'a'.repeat(64), platformAgentId: 'pagt_1', versionId: 'pav_1' };
    const modelPin = {
      modelKey: 'chat',
      providerChecksum: 'b'.repeat(64),
      providerKey: 'openai',
      providerRevision: 1,
    };
    // A COMPLETE platform-start binding: all four pins (empty skill/connector arrays are valid) + the
    // server-owned assistant anchor.
    const complete = (overrides: Record<string, unknown> = {}) => ({
      assistantMessageId: 'asst-1',
      platformConnectors: [],
      platformModel: modelPin,
      platformOperation: pin,
      platformSkills: [],
      ...overrides,
    });
    const start = (model: AgentOperationModel, metadata: Record<string, unknown>, id = 'op-p') =>
      model.recordStart({ metadata, operationId: id });
    const model = () => new AgentOperationModel(serverDB, userId);

    it('is exact-idempotent when the existing row is this owner with identical COMPLETE metadata', async () => {
      await start(model(), complete());
      await expect(start(model(), complete())).resolves.toBeUndefined();
      // A populated (non-empty) skill/connector set is also idempotent when identical.
      const withRefs = complete({
        assistantMessageId: 'asst-2',
        platformSkills: [{ checksum: 'c'.repeat(64), skillKey: 's', version: '1' }],
      });
      await start(model(), withRefs, 'op-refs');
      await expect(start(model(), withRefs, 'op-refs')).resolves.toBeUndefined();
    });

    it('fails the start closed when the DESIRED metadata is incomplete (missing assistant / a pin)', async () => {
      const { assistantMessageId: _a, ...noAssistant } = complete();
      await expect(start(model(), noAssistant, 'op-a')).rejects.toThrow(
        'PLATFORM_OPERATION_START_CONFLICT',
      );
      const { platformSkills: _s, ...noSkills } = complete();
      await expect(start(model(), noSkills, 'op-b')).rejects.toThrow(
        'PLATFORM_OPERATION_START_CONFLICT',
      );
      const { platformConnectors: _c, ...noConnectors } = complete();
      await expect(start(model(), noConnectors, 'op-c')).rejects.toThrow(
        'PLATFORM_OPERATION_START_CONFLICT',
      );
    });

    it('fails closed when the existing row has the SAME pins but a different assistant anchor', async () => {
      await start(model(), complete({ assistantMessageId: 'asst-EXISTING' }));
      await expect(
        start(model(), complete({ assistantMessageId: 'asst-DESIRED' })),
      ).rejects.toThrow('PLATFORM_OPERATION_START_CONFLICT');
    });

    it('fails closed when the existing row is incomplete (missing assistant binding)', async () => {
      // Seed a pre-existing platform-ish row WITHOUT the assistant anchor (bypassing recordStart).
      await serverDB.insert(agentOperations).values({
        id: 'op-p',
        metadata: {
          platformConnectors: [],
          platformModel: modelPin,
          platformOperation: pin,
          platformSkills: [],
        },
        startedAt: new Date(),
        status: 'running',
        userId,
      });
      await expect(start(model(), complete())).rejects.toThrow('PLATFORM_OPERATION_START_CONFLICT');
    });

    it('fails closed when a pre-existing row is an ordinary (no-pin) operation', async () => {
      await model().recordStart({ operationId: 'op-p' });
      await expect(start(model(), complete())).rejects.toThrow('PLATFORM_OPERATION_START_CONFLICT');
    });

    it('fails closed when the existing row carries an inconsistent (different) pin', async () => {
      await start(model(), complete({ platformOperation: { ...pin, versionId: 'pav_OTHER' } }));
      await expect(start(model(), complete())).rejects.toThrow('PLATFORM_OPERATION_START_CONFLICT');
    });

    it('fails closed when the existing row belongs to another owner', async () => {
      await start(new AgentOperationModel(serverDB, otherUserId), complete());
      await expect(start(model(), complete())).rejects.toThrow('PLATFORM_OPERATION_START_CONFLICT');
    });

    it('keeps ordinary operations idempotent on conflict (no throw)', async () => {
      await model().recordStart({ operationId: 'op-o' });
      await expect(model().recordStart({ operationId: 'op-o' })).resolves.toBeUndefined();
    });
  });

  describe('findPlatformModelPin', () => {
    const modelPin = {
      modelKey: 'chat-model',
      providerChecksum: 'b'.repeat(64),
      providerKey: 'internal-provider',
      providerRevision: 1,
    };

    it('returns the exact model pin owner-scoped, null for another user or an ordinary op', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      await model.recordStart({ metadata: { platformModel: modelPin }, operationId: 'op-model' });
      await model.recordStart({ operationId: 'op-plain' });

      expect(await model.findPlatformModelPin('op-model')).toEqual(modelPin);
      expect(await model.findPlatformModelPin('op-plain')).toBeNull();
      // Owner isolation: another user cannot read the pin via a leaked operationId.
      expect(
        await new AgentOperationModel(serverDB, otherUserId).findPlatformModelPin('op-model'),
      ).toBeNull();
    });
  });
});
