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

  describe('findLatestPlatformOperationPin', () => {
    const pin = { checksum: 'a'.repeat(64), platformAgentId: 'pagt_1', versionId: 'pav_1' };

    // agent_operations.topic_id / thread_id are FK-restricted, so seed the referenced rows.
    beforeEach(async () => {
      await serverDB.insert(topics).values([
        { id: 'topic-1', userId },
        { id: 'topic-2', userId },
      ]);
      await serverDB
        .insert(threads)
        .values([{ id: 'thread-1', topicId: 'topic-1', type: 'standalone', userId }]);
    });

    const seed = (
      model: AgentOperationModel,
      params: {
        operationId: string;
        pin?: typeof pin;
        startedAt: Date;
        threadId?: string | null;
        topicId: string;
      },
    ) =>
      model.recordStart({
        metadata: params.pin ? { platformOperation: params.pin } : undefined,
        operationId: params.operationId,
        startedAt: params.startedAt,
        threadId: params.threadId ?? null,
        topicId: params.topicId,
      });

    it('returns the pin of the most recent platform operation on the topic', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      await seed(model, {
        operationId: 'op-v1',
        pin,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        topicId: 'topic-1',
      });
      await seed(model, {
        operationId: 'op-v2',
        pin: { ...pin, checksum: 'c'.repeat(64), versionId: 'pav_2' },
        startedAt: new Date('2024-01-02T00:00:00Z'),
        topicId: 'topic-1',
      });

      expect(await model.findLatestPlatformOperationPin({ topicId: 'topic-1' })).toEqual({
        ...pin,
        checksum: 'c'.repeat(64),
        versionId: 'pav_2',
      });
    });

    it('is owner-scoped: another user never sees the pin', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      await seed(model, {
        operationId: 'op-a',
        pin,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        topicId: 'topic-1',
      });
      const other = new AgentOperationModel(serverDB, otherUserId);
      expect(await other.findLatestPlatformOperationPin({ topicId: 'topic-1' })).toBeNull();
    });

    it('matches the thread and returns null when there is no platform operation', async () => {
      const model = new AgentOperationModel(serverDB, userId);
      await seed(model, {
        operationId: 'op-thread',
        pin,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        threadId: 'thread-1',
        topicId: 'topic-1',
      });
      // Non-platform operation (no pin) on another topic must not resolve.
      await seed(model, {
        operationId: 'op-plain',
        startedAt: new Date('2024-01-03T00:00:00Z'),
        topicId: 'topic-2',
      });

      expect(
        await model.findLatestPlatformOperationPin({ threadId: 'thread-1', topicId: 'topic-1' }),
      ).toEqual(pin);
      // A thread mismatch (asking for the null-thread turn) finds nothing.
      expect(await model.findLatestPlatformOperationPin({ topicId: 'topic-1' })).toBeNull();
      expect(await model.findLatestPlatformOperationPin({ topicId: 'topic-2' })).toBeNull();
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
