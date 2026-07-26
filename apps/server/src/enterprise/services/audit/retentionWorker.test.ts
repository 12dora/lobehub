// @vitest-environment node
/**
 * Retention worker: dry-run no delete, execute scopes, holds, cancel, retry, cascade.
 * Sequential — shared real DB.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messages, sessions, topics, users } from '@/database/schemas';
import {
  platformAuditExports,
  platformAuditLegalHolds,
  platformAuditLogs,
  platformAuditPolicies,
  platformAuditRetentionRuns,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import {
  AdminAuditRetentionService,
  InMemoryAuditExportArtifactStorage,
  processNextAuditRetentionJob,
} from './index';

const serverDB: LobeChatDatabase = await getTestDB();
const storage = new InMemoryAuditExportArtifactStorage();
const actor = 'audit-retention-worker-actor';
const userA = 'audit-retention-worker-user';
const sessionA = 'audit-retention-session-a';

const oldDate = new Date('2020-01-01T00:00:00.000Z');
const recentDate = new Date(Date.now() - 60_000);

/** Test cleanup: bypass append-only trigger on platform_audit_logs. */
const clearAuditLogs = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(async () => {
  storage.objects.clear();
  await clearAuditLogs();
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformAuditRetentionRuns);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(sessions);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.delete(users).where(eq(users.id, userA));
  await serverDB.insert(users).values([{ id: actor }, { id: userA }]);
  // Short retention so oldDate is always past cutoff
  await serverDB.insert(platformAuditPolicies).values({
    id: 'global',
    conversationRetentionDays: 30,
    exportArtifactRetentionDays: 7,
    operationLogRetentionDays: 30,
    revision: 1,
  });
});

afterEach(async () => {
  await clearAuditLogs();
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformAuditRetentionRuns);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(sessions);
});

const drainRetentionJobs = async (max = 10) => {
  for (let i = 0; i < max; i++) {
    const r = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: `ret-worker-${i}`,
    });
    if (!r.claimed) break;
  }
};

describe('audit retention worker', () => {
  it('dry-run scans operation logs without deleting', async () => {
    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'admin.settings.publish',
        createdAt: oldDate,
        id: 'oplog-old-1',
        result: 'success',
        targetType: 'settings',
      },
      {
        action: 'admin.settings.publish',
        createdAt: recentDate,
        id: 'oplog-new-1',
        result: 'success',
        targetType: 'settings',
      },
    ]);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'dry op logs', scope: 'operation_logs' },
    });

    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.operationLogsScanned).toBeGreaterThanOrEqual(1);
    expect(run.counts.operationLogsDeleted ?? 0).toBe(0);

    const stillThere = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'oplog-old-1'));
    expect(stillThere).toHaveLength(1);
  });

  it('execute deletes old operation logs and preserves recent retention audit logs', async () => {
    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'admin.settings.publish',
        actorUserId: userA,
        createdAt: oldDate,
        id: 'oplog-del-1',
        result: 'success',
        targetType: 'settings',
      },
      {
        action: 'admin.settings.publish',
        createdAt: recentDate,
        id: 'oplog-keep-1',
        result: 'success',
        targetType: 'settings',
      },
    ]);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'exec op logs', scope: 'operation_logs' },
    });

    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.operationLogsDeleted).toBeGreaterThanOrEqual(1);

    const deleted = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'oplog-del-1'));
    expect(deleted).toHaveLength(0);

    const kept = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'oplog-keep-1'));
    expect(kept).toHaveLength(1);

    // Self-audit / worker outcome rows are recent (newer than cutoff)
    const auditRows = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.retention.worker'));
    expect(auditRows.some((r) => r.result === 'success')).toBe(true);
  });

  it('execute deletes old topics with cascade messages and preserves sessions', async () => {
    await serverDB.insert(sessions).values({
      id: sessionA,
      slug: 'ret-session',
      title: 'Keep session',
      userId: userA,
    });
    await serverDB.insert(topics).values({
      id: 'topic-old-1',
      sessionId: sessionA,
      status: 'completed',
      title: 'Old topic',
      updatedAt: oldDate,
      userId: userA,
    });
    await serverDB.insert(messages).values([
      {
        id: 'msg-old-1',
        role: 'user',
        content: 'hello',
        topicId: 'topic-old-1',
        userId: userA,
      },
      {
        id: 'msg-old-2',
        role: 'assistant',
        content: 'world',
        topicId: 'topic-old-1',
        userId: userA,
      },
    ]);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'exec conversations', scope: 'conversations' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.topicsDeleted).toBeGreaterThanOrEqual(1);
    expect(run.counts.messagesDeleted).toBeGreaterThanOrEqual(2);
    expect(run.counts.sessionsDeleted).toBe(0);

    const topicGone = await serverDB.select().from(topics).where(eq(topics.id, 'topic-old-1'));
    expect(topicGone).toHaveLength(0);
    const msgsGone = await serverDB
      .select()
      .from(messages)
      .where(eq(messages.topicId, 'topic-old-1'));
    expect(msgsGone).toHaveLength(0);

    const sessionKept = await serverDB.select().from(sessions).where(eq(sessions.id, sessionA));
    expect(sessionKept).toHaveLength(1);
  });

  it('preserves running topics even when past cutoff', async () => {
    await serverDB.insert(topics).values({
      id: 'topic-running-1',
      status: 'running',
      title: 'Still running',
      updatedAt: oldDate,
      userId: userA,
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'preserve running', scope: 'conversations' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.topicsDeleted ?? 0).toBe(0);

    const kept = await serverDB.select().from(topics).where(eq(topics.id, 'topic-running-1'));
    expect(kept).toHaveLength(1);
  });

  it('honors global legal hold by skipping all candidates', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      createdAt: oldDate,
      id: 'oplog-held-global',
      result: 'success',
      targetType: 'settings',
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-global-1',
      reason: 'litigation hold',
      scopeType: 'global',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'global hold', scope: 'operation_logs' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.skippedLegalHold).toBeGreaterThanOrEqual(1);
    expect(run.counts.operationLogsDeleted ?? 0).toBe(0);

    const kept = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'oplog-held-global'));
    expect(kept).toHaveLength(1);
  });

  it('honors user and topic holds for conversations', async () => {
    await serverDB.insert(topics).values([
      {
        id: 'topic-user-hold',
        status: 'completed',
        title: 'User held',
        updatedAt: oldDate,
        userId: userA,
      },
      {
        id: 'topic-topic-hold',
        status: 'completed',
        title: 'Topic held',
        updatedAt: oldDate,
        userId: actor,
      },
    ]);
    await serverDB.insert(platformAuditLegalHolds).values([
      {
        createdBy: actor,
        id: 'hold-user-1',
        reason: 'user hold',
        scopeId: userA,
        scopeType: 'user',
        status: 'active',
      },
      {
        createdBy: actor,
        id: 'hold-topic-1',
        reason: 'topic hold',
        scopeId: 'topic-topic-hold',
        scopeType: 'topic',
        status: 'active',
      },
    ]);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'scoped holds', scope: 'conversations' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.skippedLegalHold).toBeGreaterThanOrEqual(2);
    expect(run.counts.topicsDeleted ?? 0).toBe(0);

    expect(
      (await serverDB.select().from(topics).where(eq(topics.id, 'topic-user-hold'))).length,
    ).toBe(1);
    expect(
      (await serverDB.select().from(topics).where(eq(topics.id, 'topic-topic-hold'))).length,
    ).toBe(1);
  });

  it('export artifacts: deletes private object and clears storageKey', async () => {
    const exportId = 'export-ret-1';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"manifest"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 20,
      artifactChecksum: 'sha256:abc',
      createdAt: oldDate,
      expiresAt: oldDate,
      filterSnapshot: { userId: userA },
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'artifact purge', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsDeleted).toBeGreaterThanOrEqual(1);

    expect(storage.objects.has(storageKey)).toBe(false);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('expired');
    expect(row[0]?.storageKey).toBeNull();
    // Retain checksum/bytes history
    expect(row[0]?.artifactChecksum).toBe('sha256:abc');
    expect(row[0]?.artifactBytes).toBe(20);
  });

  it('export artifacts: skips purge when filter actorUserId matches user hold', async () => {
    const exportId = 'export-held-actor';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"operation_log"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 12,
      artifactChecksum: 'sha256:held-actor',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        actorUserId: userA,
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-export-actor',
      reason: 'actor evidence hold',
      scopeId: userA,
      scopeType: 'user',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'held actor export', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.skippedLegalHold).toBe(1);
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(storage.objects.has(storageKey)).toBe(true);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('completed');
    expect(row[0]?.storageKey).toBe(storageKey);
  });

  it('export artifacts: skips purge when filter topicId matches topic hold', async () => {
    const exportId = 'export-held-topic';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    const heldTopicId = 'topic-export-held';
    storage.objects.set(storageKey, Buffer.from('{"type":"conversation_topic"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 14,
      artifactChecksum: 'sha256:held-topic',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
        topicId: heldTopicId,
        userId: userA,
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-export-topic',
      reason: 'topic evidence hold',
      scopeId: heldTopicId,
      scopeType: 'topic',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'held topic export', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.skippedLegalHold).toBe(1);
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(storage.objects.has(storageKey)).toBe(true);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('completed');
    expect(row[0]?.storageKey).toBe(storageKey);
  });

  it('export artifacts: skips purge for broad op-log filter when any scoped hold exists', async () => {
    const exportId = 'export-held-broad';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"operation_log"}\n'));

    // Time/action-only freeze — can include evidence for any held actor/target.
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 10,
      artifactChecksum: 'sha256:held-broad',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        action: 'admin.settings.publish',
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      rowCount: 3,
      status: 'completed',
      storageKey,
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-export-broad-user',
      reason: 'unrelated-looking user hold still covers broad exports',
      scopeId: userA,
      scopeType: 'user',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'broad held export', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.skippedLegalHold).toBe(1);
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(storage.objects.has(storageKey)).toBe(true);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('completed');
    expect(row[0]?.storageKey).toBe(storageKey);
  });

  it('export artifacts: skips purge for operation_logs with only q/time filter under user hold', async () => {
    // Regression: `q` is valid on operation_logs. Kind must come from the row,
    // not filter heuristics that treat `q` as conversation-like (under-retain).
    const exportId = 'export-held-oplog-q';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"operation_log"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 10,
      artifactChecksum: 'sha256:held-oplog-q',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        from: oldDate.toISOString(),
        q: 'settings',
        to: oldDate.toISOString(),
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      rowCount: 2,
      status: 'completed',
      storageKey,
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-export-oplog-q-user',
      reason: 'user hold must cover broad operation_logs q exports',
      scopeId: userA,
      scopeType: 'user',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'oplog q held export', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.skippedLegalHold).toBe(1);
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(storage.objects.has(storageKey)).toBe(true);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('completed');
    expect(row[0]?.storageKey).toBe(storageKey);
  });

  it('export artifacts: purges when exact conversation userId is disjoint from user holds', async () => {
    // Provable disjoint: conversations export pinned to userA cannot include userB-only holds.
    const exportId = 'export-disjoint-user';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"conversation_topic"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 11,
      artifactChecksum: 'sha256:disjoint-user',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
        userId: userA,
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-export-other-user',
      reason: 'hold on a different user only',
      scopeId: actor,
      scopeType: 'user',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'disjoint user export', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.skippedLegalHold ?? 0).toBe(0);
    expect(run.counts.exportArtifactsDeleted).toBe(1);
    expect(storage.objects.has(storageKey)).toBe(false);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.status).toBe('expired');
    expect(row[0]?.storageKey).toBeNull();
  });

  it('export artifacts: aborts object delete when hold is inserted between claim and authorize', async () => {
    // Worker-level C1 race: claim writes purge outbox, then a hold appears before
    // authorize — object must remain and storageKey must be restored.
    const exportId = 'export-race-hold-midflight';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"conversation_topic"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 15,
      artifactChecksum: 'sha256:race-hold',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
        userId: userA,
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'race hold midflight', scope: 'export_artifacts' },
    });

    const result = await processNextAuditRetentionJob(serverDB, {
      afterArtifactClaim: async ({ claimed }) => {
        expect(claimed).toEqual([{ id: exportId, storageKey }]);
        // Interleave: hold covering the export filter after claim-commit.
        await serverDB.insert(platformAuditLegalHolds).values({
          createdBy: actor,
          id: 'hold-midflight-user',
          reason: 'litigation after claim',
          scopeId: userA,
          scopeType: 'user',
          status: 'active',
        });
      },
      storage,
      workerId: 'race-hold-worker',
    });

    expect(result.claimed).toBe(true);
    expect(result.outcome).toBe('completed');

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsScanned).toBe(1);
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(run.counts.skippedLegalHold).toBeGreaterThanOrEqual(1);

    // Object must still exist; storageKey restored for addressability.
    expect(storage.objects.has(storageKey)).toBe(true);
    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.storageKey).toBe(storageKey);
    expect(row[0]?.error?.code).toBe('ARTIFACT_PURGE_DEFERRED_HOLD');
  });

  it('export artifacts: aborts object delete when hold is inserted between authorize and delete', async () => {
    // authorize→delete race: first authorize succeeds, then a hold appears before
    // the final pre-delete re-authorize — object must remain.
    const exportId = 'export-race-hold-post-auth';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"conversation_topic"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 15,
      artifactChecksum: 'sha256:race-post-auth',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {
        from: oldDate.toISOString(),
        to: oldDate.toISOString(),
        userId: userA,
      },
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'race hold post authorize', scope: 'export_artifacts' },
    });

    const result = await processNextAuditRetentionJob(serverDB, {
      afterArtifactAuthorize: async ({ authorized }) => {
        expect(authorized).toEqual([{ id: exportId, storageKey }]);
        await serverDB.insert(platformAuditLegalHolds).values({
          createdBy: actor,
          id: 'hold-post-auth-user',
          reason: 'litigation after authorize',
          scopeId: userA,
          scopeType: 'user',
          status: 'active',
        });
      },
      storage,
      workerId: 'race-hold-post-auth-worker',
    });

    expect(result.claimed).toBe(true);
    expect(result.outcome).toBe('completed');

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(run.counts.skippedLegalHold).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(storageKey)).toBe(true);

    const row = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row[0]?.storageKey).toBe(storageKey);
    expect(row[0]?.error?.code).toBe('ARTIFACT_PURGE_DEFERRED_HOLD');
  });

  it('cancel mid-flight stops the domain run and job', async () => {
    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'cancel mid', scope: 'operation_logs' },
    });
    const cancelled = await service.cancel({
      actorUserId: actor,
      input: { id: created.items[0]!.id, reason: 'stop now' },
    });
    expect(cancelled.status).toBe('cancelled');

    const result = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: 'cancel-check',
    });
    // Job already cancelled → claim may pick nothing or skip cancelled
    if (result.claimed) {
      expect(['cancelled', 'skipped', 'failed']).toContain(result.outcome);
    }
  });

  it('completed run does not re-delete when a second worker claims nothing', async () => {
    // Idempotency after a full successful claim (not a mid-flight retry).
    // Post-checkpoint retry coverage lives in the afterBatchCheckpoint seam tests.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      action: 'admin.test.action',
      createdAt: oldDate,
      id: `oplog-retry-${i}`,
      result: 'success' as const,
      targetType: 'settings',
    }));
    await serverDB.insert(platformAuditLogs).values(rows);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'retry path', scope: 'operation_logs' },
    });

    // First process should complete in one claim for 5 rows (batch 50)
    const first = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: 'retry-w1',
    });
    expect(first.outcome).toBe('completed');

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.counts.operationLogsDeleted).toBe(5);

    // Second claim should not re-delete (nothing left / job done)
    const second = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: 'retry-w2',
    });
    expect(second.claimed).toBe(false);

    const run2 = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run2.counts.operationLogsDeleted).toBe(5);
  });

  it('all fanout creates three jobs that each complete', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.test.action',
      createdAt: oldDate,
      id: 'oplog-fanout-1',
      result: 'success',
      targetType: 'settings',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'fanout complete', scope: 'all' },
    });
    expect(created.items).toHaveLength(3);

    await drainRetentionJobs(5);

    for (const item of created.items) {
      const run = await service.getRun({ actorUserId: actor, id: item.id });
      expect(run.status).toBe('completed');
    }
  });

  it('recently completed export created long ago is not purged; finishedAt preserved; cleared not recounted', async () => {
    const recentFinish = new Date(Date.now() - 30_000);
    const originalFinishedAt = new Date('2020-06-01T00:00:00.000Z');

    // Created long ago but completed recently → must NOT be purged by finishedAt eligibility
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 11,
      artifactChecksum: 'sha256:recent',
      createdAt: oldDate,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      finishedAt: recentFinish,
      filterSnapshot: {},
      id: 'export-recent-finish',
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      status: 'completed',
      storageKey: 'platform-audit-exports/export-recent-finish/evidence.ndjson',
    });
    storage.objects.set(
      'platform-audit-exports/export-recent-finish/evidence.ndjson',
      Buffer.from('x'),
    );

    // Eligible old completed artifact
    const oldKey = 'platform-audit-exports/export-old-finish/evidence.ndjson';
    storage.objects.set(oldKey, Buffer.from('old'));
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 22,
      artifactChecksum: 'sha256:old',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: originalFinishedAt,
      filterSnapshot: {},
      id: 'export-old-finish',
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      status: 'completed',
      storageKey: oldKey,
    });

    // Already cleared expired — must never reappear / be recounted
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 33,
      artifactChecksum: 'sha256:cleared',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: originalFinishedAt,
      filterSnapshot: {},
      id: 'export-already-cleared',
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      status: 'expired',
      storageKey: null,
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'artifact eligibility', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.exportArtifactsDeleted).toBe(1);
    expect(run.counts.exportArtifactsScanned).toBe(1);

    const recent = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, 'export-recent-finish'));
    expect(recent[0]?.status).toBe('completed');
    expect(recent[0]?.storageKey).toBeTruthy();

    const purged = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, 'export-old-finish'));
    expect(purged[0]?.status).toBe('expired');
    expect(purged[0]?.storageKey).toBeNull();
    expect(purged[0]?.artifactChecksum).toBe('sha256:old');
    expect(purged[0]?.finishedAt?.toISOString()).toBe(originalFinishedAt.toISOString());

    // Second run must not recount already-cleared rows
    const created2 = await service.run({
      actorUserId: actor,
      input: { reason: 'artifact no recount', scope: 'export_artifacts' },
    });
    await drainRetentionJobs();
    const run2 = await service.getRun({ actorUserId: actor, id: created2.items[0]!.id });
    expect(run2.status).toBe('completed');
    expect(run2.counts.exportArtifactsScanned ?? 0).toBe(0);
    expect(run2.counts.exportArtifactsDeleted ?? 0).toBe(0);
  });

  it('multi-page dry_run scans >batch size with held rows and advances final-page cursor', async () => {
    // AUDIT_RETENTION_BATCH_LIMIT = 50; seed 55 eligible + hold on a few
    const rows = Array.from({ length: 55 }, (_, i) => ({
      action: 'admin.test.action',
      actorUserId: i < 3 ? userA : null,
      createdAt: oldDate,
      id: `oplog-multipage-${String(i).padStart(3, '0')}`,
      result: 'success' as const,
      targetType: 'settings',
    }));
    await serverDB.insert(platformAuditLogs).values(rows);
    await serverDB.insert(platformAuditLegalHolds).values({
      createdBy: actor,
      id: 'hold-multipage-user',
      reason: 'hold userA logs',
      scopeId: userA,
      scopeType: 'user',
      status: 'active',
    });

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'multi page dry', scope: 'operation_logs' },
    });

    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    expect(run.counts.operationLogsScanned).toBe(55);
    expect(run.counts.skippedLegalHold).toBe(3);
    expect(run.counts.operationLogsDeleted ?? 0).toBe(0);

    // Final-page cursor persisted on the platform job even though there is no next page
    const job = await serverDB.query.platformJobs.findFirst({
      where: eq(platformJobs.id, created.items[0]!.jobId!),
    });
    expect(job?.status).toBe('succeeded');
    expect(job?.cursor).toMatchObject({ v: 1 });
    expect((job?.cursor as { keyset?: string } | null)?.keyset).toBeTruthy();
  });

  it('transient failure after checkpoint then retry does not double-count', async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      action: 'admin.test.action',
      createdAt: oldDate,
      id: `oplog-ckpt-${String(i).padStart(3, '0')}`,
      result: 'success' as const,
      targetType: 'settings',
    }));
    await serverDB.insert(platformAuditLogs).values(rows);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'ckpt retry', scope: 'operation_logs' },
    });

    let checkpoints = 0;
    const first = await processNextAuditRetentionJob(serverDB, {
      afterBatchCheckpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 1) {
          throw new Error('INJECTED_TRANSIENT_AFTER_CHECKPOINT');
        }
      },
      storage,
      workerId: 'ckpt-w1',
    });
    expect(first.outcome).toBe('retry');
    expect(checkpoints).toBe(1);

    const mid = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(mid.status).toBe('running');
    // First page only (batch 50) should be durable
    expect(mid.counts.operationLogsDeleted).toBe(50);
    expect(mid.counts.operationLogsScanned).toBe(50);

    const jobMid = await serverDB.query.platformJobs.findFirst({
      where: eq(platformJobs.id, created.items[0]!.jobId!),
    });
    expect(jobMid?.status).toBe('pending'); // requeued
    expect((jobMid?.cursor as { keyset?: string } | null)?.keyset).toBeTruthy();

    const second = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: 'ckpt-w2',
    });
    expect(second.outcome).toBe('completed');

    const done = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(done.status).toBe('completed');
    // No double count: 50 + 5, not 50+55 or 110
    expect(done.counts.operationLogsDeleted).toBe(55);
    expect(done.counts.operationLogsScanned).toBe(55);
  });

  it('credits recovered post-checkpoint artifact deletion to its originating run once', async () => {
    const exportId = 'export-artifact-checkpoint-recovery';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"manifest"}\n'));
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 20,
      artifactChecksum: 'sha256:checkpoint',
      createdAt: oldDate,
      expiresAt: oldDate,
      filterSnapshot: { userId: userA },
      finishedAt: oldDate,
      id: exportId,
      includesMessageBodies: false,
      kind: 'conversations',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });
    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'artifact checkpoint recovery', scope: 'export_artifacts' },
    });
    const runId = created.items[0]!.id;

    const first = await processNextAuditRetentionJob(serverDB, {
      afterBatchCheckpoint: async () => {
        throw new Error('CRASH_AFTER_ARTIFACT_CHECKPOINT');
      },
      storage,
      workerId: 'artifact-checkpoint-first',
    });
    expect(first.outcome).toBe('retry');
    expect(storage.objects.has(storageKey)).toBe(true);

    const second = await processNextAuditRetentionJob(serverDB, {
      storage,
      workerId: 'artifact-checkpoint-second',
    });
    expect(second.outcome).toBe('completed');
    const done = await service.getRun({ actorUserId: actor, id: runId });
    expect(done.counts.exportArtifactsScanned).toBe(1);
    expect(done.counts.exportArtifactsDeleted).toBe(1);
    expect(storage.objects.has(storageKey)).toBe(false);
  });

  it('keeps purge intent pending when delete and metadata probe fail transiently', async () => {
    const exportId = 'export-transient-head';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"manifest"}\n'));
    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 20,
      artifactChecksum: 'sha256:head',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      id: exportId,
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });
    const transientStorage = new InMemoryAuditExportArtifactStorage();
    transientStorage.objects.set(storageKey, storage.objects.get(storageKey)!);
    transientStorage.deleteObject = async () => {
      throw new Error('S3_TIMEOUT');
    };
    transientStorage.getObjectMetadata = async () => {
      throw Object.assign(new Error('Access denied'), {
        $metadata: { httpStatusCode: 403 },
        name: 'AccessDenied',
      });
    };
    const service = new AdminAuditRetentionService(serverDB, { storage: transientStorage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'transient head', scope: 'export_artifacts' },
    });
    await processNextAuditRetentionJob(serverDB, {
      storage: transientStorage,
      workerId: 'transient-head-worker',
    });

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    const [artifact] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(run.counts.exportArtifactsDeleted ?? 0).toBe(0);
    expect(transientStorage.objects.has(storageKey)).toBe(true);
    expect(artifact?.error?.purgeStorageKey).toBe(storageKey);
    expect(artifact?.error?.purgeStatus).toBe('deleting');
  });

  it('rolls back contract-error terminal state when its required audit append fails', async () => {
    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'contract audit rollback', scope: 'operation_logs' },
    });
    const runId = created.items[0]!.id;
    const jobId = created.items[0]!.jobId!;
    await serverDB
      .update(platformJobs)
      .set({ cursor: { invalid: true } })
      .where(eq(platformJobs.id, jobId));
    const append = vi
      .spyOn(PlatformAuditService.prototype, 'append')
      .mockRejectedValueOnce(new Error('AUDIT_TABLE_UNAVAILABLE'));
    try {
      await expect(
        processNextAuditRetentionJob(serverDB, {
          storage,
          workerId: 'contract-audit-rollback',
        }),
      ).rejects.toThrow('AUDIT_TABLE_UNAVAILABLE');
    } finally {
      append.mockRestore();
    }

    const run = await service.getRun({ actorUserId: actor, id: runId });
    const [job] = await serverDB.select().from(platformJobs).where(eq(platformJobs.id, jobId));
    expect(run.status).toBe('running');
    expect(job?.status).toBe('running');
  });

  it('rolls back dead-letter terminal state when its required audit append fails', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.test.action',
      createdAt: oldDate,
      id: 'oplog-dead-audit-rollback',
      result: 'success',
      targetType: 'settings',
    });
    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'dead audit rollback', scope: 'operation_logs' },
    });
    const runId = created.items[0]!.id;
    const jobId = created.items[0]!.jobId!;
    await serverDB.update(platformJobs).set({ maxAttempts: 1 }).where(eq(platformJobs.id, jobId));
    const append = vi
      .spyOn(PlatformAuditService.prototype, 'append')
      .mockRejectedValueOnce(new Error('AUDIT_TABLE_UNAVAILABLE'));
    try {
      await expect(
        processNextAuditRetentionJob(serverDB, {
          afterBatchCheckpoint: async () => {
            throw new Error('TRANSIENT_AFTER_CHECKPOINT');
          },
          storage,
          workerId: 'dead-audit-rollback',
        }),
      ).rejects.toThrow('AUDIT_TABLE_UNAVAILABLE');
    } finally {
      append.mockRestore();
    }

    const run = await service.getRun({ actorUserId: actor, id: runId });
    const [job] = await serverDB.select().from(platformJobs).where(eq(platformJobs.id, jobId));
    expect(run.status).toBe('running');
    expect(job?.status).toBe('running');
  });

  it('lease loss does not cancel domain run or platform job', async () => {
    // Multi-page so we can steal the lease after the first durable checkpoint.
    await serverDB.insert(platformAuditLogs).values(
      Array.from({ length: 55 }, (_, i) => ({
        action: 'admin.test.action',
        createdAt: oldDate,
        id: `oplog-lease-${String(i).padStart(3, '0')}`,
        result: 'success' as const,
        targetType: 'settings',
      })),
    );

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'lease loss', scope: 'operation_logs' },
    });
    const runId = created.items[0]!.id;
    const jobId = created.items[0]!.jobId!;

    const result = await processNextAuditRetentionJob(serverDB, {
      afterBatchCheckpoint: async () => {
        // Steal lease after progress/cursor are durable — next renewLease must LeaseLost.
        await serverDB
          .update(platformJobs)
          .set({
            leaseOwner: 'thief',
            leaseUntil: new Date(Date.now() + 120_000),
          })
          .where(eq(platformJobs.id, jobId));
      },
      storage,
      workerId: 'lease-loser',
    });

    expect(result.outcome).toBe('skipped');

    const run = await service.getRun({ actorUserId: actor, id: runId });
    // Domain must remain open (or completed only if fully done before steal — multi-page prevents that)
    expect(run.status).not.toBe('cancelled');
    expect(run.status).toBe('running');

    const job = await serverDB.query.platformJobs.findFirst({ where: eq(platformJobs.id, jobId) });
    expect(job?.status).not.toBe('cancelled');
    expect(job?.status).toBe('running');
    expect(job?.leaseOwner).toBe('thief');
  });

  it('final jobs.complete lease loss does not report clean completion or cancel domain', async () => {
    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'final complete lease loss', scope: 'operation_logs' },
    });
    const runId = created.items[0]!.id;
    const jobId = created.items[0]!.jobId!;

    const result = await processNextAuditRetentionJob(serverDB, {
      afterDomainComplete: async () => {
        // Steal lease before the terminal TX (domain complete + job succeed + audit).
        await serverDB
          .update(platformJobs)
          .set({
            leaseOwner: 'thief',
            leaseUntil: new Date(Date.now() + 120_000),
          })
          .where(eq(platformJobs.id, jobId));
      },
      storage,
      workerId: 'final-lease-loser',
    });

    // Stale worker must not claim a clean completion.
    expect(result.outcome).toBe('skipped');
    expect(result.outcome).not.toBe('completed');
    expect(result.outcome).not.toBe('cancelled');

    const run = await service.getRun({ actorUserId: actor, id: runId });
    // Domain complete is in the same TX as job.complete — lease loss rolls it back
    // so a reclaiming owner can finish without a half-written terminal state (F5).
    expect(run.status).not.toBe('completed');
    expect(run.status).not.toBe('cancelled');
    expect(['pending', 'running']).toContain(run.status);

    const job = await serverDB.query.platformJobs.findFirst({
      where: eq(platformJobs.id, jobId),
    });
    // Platform job remains for reclaim — not succeeded by the stale worker.
    expect(job?.status).toBe('running');
    expect(job?.status).not.toBe('succeeded');
    expect(job?.status).not.toBe('cancelled');
    expect(job?.leaseOwner).toBe('thief');
  });

  it('does not scan or delete unknown/future topic statuses', async () => {
    await serverDB.insert(topics).values([
      {
        id: 'topic-future-status',
        status: 'scheduledForReview' as 'active',
        title: 'future',
        updatedAt: oldDate,
        userId: userA,
      },
      {
        id: 'topic-null-legacy',
        status: null,
        title: 'legacy',
        updatedAt: oldDate,
        userId: userA,
      },
    ]);

    const service = new AdminAuditRetentionService(serverDB, { storage });
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'unknown topic status', scope: 'conversations' },
    });
    await drainRetentionJobs();

    const run = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(run.status).toBe('completed');
    // Only legacy null is purgeable among the two fixtures.
    expect(run.counts.topicsDeleted).toBe(1);
    expect(run.counts.topicsScanned).toBe(1);

    const future = await serverDB.select().from(topics).where(eq(topics.id, 'topic-future-status'));
    expect(future).toHaveLength(1);

    const legacy = await serverDB.select().from(topics).where(eq(topics.id, 'topic-null-legacy'));
    expect(legacy).toHaveLength(0);
  });

  it('F12: cleanup-retry — delete fails once then outbox drains', async () => {
    const exportId = 'export-f12-cleanup-retry';
    const storageKey = `platform-audit-exports/${exportId}/evidence.ndjson`;
    storage.objects.set(storageKey, Buffer.from('{"type":"manifest"}\n'));

    await serverDB.insert(platformAuditExports).values({
      artifactBytes: 20,
      artifactChecksum: 'sha256:cleanup-retry',
      createdAt: oldDate,
      expiresAt: oldDate,
      finishedAt: oldDate,
      filterSnapshot: {},
      id: exportId,
      includesMessageBodies: false,
      kind: 'operation_logs',
      requestedBy: actor,
      rowCount: 1,
      status: 'completed',
      storageKey,
    });

    let deletes = 0;
    const flakyStorage = {
      deleteObject: async (key: string) => {
        deletes += 1;
        if (deletes === 1) throw new Error('S3_TRANSIENT_DELETE');
        storage.objects.delete(key);
      },
      getObjectMetadata: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return { contentLength: body.byteLength, contentType: 'application/x-ndjson' };
      },
      getSignedDownloadUrl: async () => 'https://audit-export.test/signed/x',
      hashObject: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: `sha256:${'a'.repeat(64)}`,
        };
      },
      uploadArtifact: async () => {
        throw new Error('upload not used');
      },
    };

    const service = new AdminAuditRetentionService(serverDB, { storage: flakyStorage });
    await service.run({
      actorUserId: actor,
      input: { reason: 'f12 cleanup retry', scope: 'export_artifacts' },
    });

    // First attempt may leave outbox pending; drain until object is gone.
    for (let i = 0; i < 8; i++) {
      await processNextAuditRetentionJob(serverDB, {
        storage: flakyStorage,
        workerId: `ret-f12-cleanup-${i}`,
      });
      if (!storage.objects.has(storageKey)) break;
    }

    expect(deletes).toBeGreaterThanOrEqual(2);
    expect(storage.objects.has(storageKey)).toBe(false);

    const [row] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, exportId));
    expect(row?.storageKey).toBeNull();
    expect(row?.status).toBe('expired');
    expect(row?.error?.purgeStorageKey).toBeFalsy();
  });

  // F12 slow-storage two-worker lease race (block inside actual delete across the
  // lease period, second worker cannot double-claim) lives in
  // retentionWorker.multiconn.pg.test.ts — requires independent PG sessions.
});
