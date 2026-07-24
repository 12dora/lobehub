// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messages, topics, users } from '@/database/schemas';
import {
  platformAuditExports,
  platformAuditLogs,
  platformAuditPolicies,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  AdminAuditExportService,
  buildAuditExportStorageKey,
  formatArtifactChecksum,
  InMemoryAuditExportArtifactStorage,
  processNextAuditExportJob,
  sha256Hex,
} from './index';

const serverDB: LobeChatDatabase = await getTestDB();
const storage = new InMemoryAuditExportArtifactStorage();

const actor = 'audit-export-worker-actor';
const userA = 'audit-export-worker-user';

const window = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-01-15T00:00:00.000Z'),
};

const clearAuditLogs = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(async () => {
  storage.objects.clear();
  await clearAuditLogs();
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.delete(users).where(eq(users.id, userA));
  await serverDB.insert(users).values([{ id: actor }, { id: userA }]);
});

afterEach(async () => {
  await clearAuditLogs();
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
});

describe('audit export worker', () => {
  it('exports operation_logs with full stored before/after diffs into NDJSON', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      afterDiff: { displayName: 'Acme Legal Entity Full Name', fingerprint: 'keep-on-export' },
      beforeDiff: { displayName: 'Old Name' },
      createdAt: new Date('2026-01-05T12:00:00.000Z'),
      id: 'op-export-1',
      result: 'success',
      targetId: 'global',
      targetType: 'settings',
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'soc export operation logs',
        to: window.to,
      },
    });

    expect(created).not.toHaveProperty('storageKey');
    expect(created.status).toBe('pending');
    expect(created.jobId).toBeTruthy();

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-1',
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'completed', exportId: created.id });

    const got = await service.get({ actorUserId: actor, id: created.id });
    expect(got.status).toBe('completed');
    expect(got.rowCount).toBe(1);
    expect(got.artifactChecksum).toMatch(/^sha256:/);
    expect(got).not.toHaveProperty('storageKey');

    const key = buildAuditExportStorageKey(created.id);
    const body = storage.objects.get(key)?.toString('utf8') ?? '';
    const lines = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: 'manifest',
      kind: 'operation_logs',
      exportId: created.id,
    });
    // Point-in-time snapshot watermark recorded on the immutable artifact.
    expect(typeof lines[0]!.snapshotAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(lines[0]!.snapshotAt)))).toBe(false);
    expect(lines[1]).toMatchObject({
      type: 'operation_log',
      id: 'op-export-1',
      afterDiff: {
        displayName: 'Acme Legal Entity Full Name',
        fingerprint: 'keep-on-export',
      },
      beforeDiff: { displayName: 'Old Name' },
    });

    const dl = await service.download({
      actorUserId: actor,
      input: { id: created.id, reason: 'download for review' },
    });
    expect(dl.downloadUrl).toContain('https://audit-export.test/signed/');
    // Signed URL may embed the key path after /signed/ — never treat raw storageKey as the API surface.
    expect(dl).not.toHaveProperty('storageKey');
    expect(JSON.stringify(dl)).not.toMatch(/"storageKey"/);
  });

  it('exports a multi-page operation_log set under a frozen snapshot (streamed NDJSON)', async () => {
    // More rows than AUDIT_EXPORT_BATCH_LIMIT (100) would require; use a small
    // set that still exercises cursor pages via sequential ids.
    const rows = Array.from({ length: 3 }, (_, i) => ({
      action: `admin.test.page.${i}`,
      createdAt: new Date(`2026-01-05T1${i}:00:00.000Z`),
      id: `op-page-${i}`,
      result: 'success' as const,
      targetType: 'settings',
    }));
    await serverDB.insert(platformAuditLogs).values(rows);

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'multi-page snapshot export',
        to: window.to,
      },
    });

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-snapshot-pages',
    });
    expect(result.outcome).toBe('completed');

    const body =
      storage.objects.get(buildAuditExportStorageKey(created.id))?.toString('utf8') ?? '';
    const lines = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'manifest', snapshotAt: expect.any(String) });
    const evidenceIds = lines
      .filter((l) => l.type === 'operation_log')
      .map((l) => l.id)
      .sort();
    expect(evidenceIds).toEqual(['op-page-0', 'op-page-1', 'op-page-2']);
  });

  it('hard-fails without partial artifact when maxExportRows is exceeded', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      maxExportRows: 1,
      revision: 0,
    });
    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'a',
        createdAt: new Date('2026-01-05T10:00:00.000Z'),
        id: 'op-a',
        result: 'success',
        targetType: 'x',
      },
      {
        action: 'b',
        createdAt: new Date('2026-01-05T11:00:00.000Z'),
        id: 'op-b',
        result: 'success',
        targetType: 'x',
      },
    ]);

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'oversize should fail',
        to: window.to,
      },
    });

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-max',
    });
    expect(result.outcome).toBe('failed');

    const got = await service.get({ actorUserId: actor, id: created.id });
    expect(got.status).toBe('failed');
    expect(got.error?.code).toBe('MAX_EXPORT_ROWS_EXCEEDED');
    expect(storage.objects.size).toBe(0);
  });

  it('exports conversation messages with credential masking only when allowed', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      contentAccessMode: 'content_allowed',
      messageBodyInExport: true,
      revision: 0,
    });
    await serverDB.insert(topics).values({
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
      id: 'topic-export-1',
      title: 'Title Only Search Hit',
      userId: userA,
    });
    const ordinary = `Business memo for ACME Corp: ${'paragraph '.repeat(50)} end.`;
    await serverDB.insert(messages).values({
      content: `${ordinary} password=super-secret-value-xyz Bearer sk-abcdefghijklmnopqrstuvwxyz012345`,
      createdAt: new Date('2026-01-06T01:00:00.000Z'),
      id: 'msg-export-1',
      role: 'user',
      topicId: 'topic-export-1',
      userId: userA,
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all', 'platform_audit:conversation_read:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: true,
        kind: 'conversations',
        q: 'Title Only',
        reason: 'conversation export with bodies',
        to: window.to,
        userId: userA,
      },
    });

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-conv',
    });
    expect(result.outcome).toBe('completed');

    const body =
      storage.objects.get(buildAuditExportStorageKey(created.id))?.toString('utf8') ?? '';
    const lines = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const msg = lines.find((l) => l.type === 'conversation_message');
    expect(msg).toBeTruthy();
    expect(String(msg!.content)).toContain('Business memo for ACME Corp');
    expect(String(msg!.content)).toContain('paragraph ');
    expect(String(msg!.content)).not.toContain('super-secret-value-xyz');
    expect(String(msg!.content)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('cancels both export row and platform job', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'will cancel',
        to: window.to,
      },
    });

    const cancelled = await service.cancel({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: { id: created.id, reason: 'no longer needed' },
    });
    expect(cancelled.status).toBe('cancelled');

    if (created.jobId) {
      const [job] = await serverDB
        .select()
        .from(platformJobs)
        .where(eq(platformJobs.id, created.jobId));
      expect(job?.status).toBe('cancelled');
    }
  });

  it('uses frozen maxExportRows/exportArtifactRetentionDays from filterSnapshot not live policy', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      exportArtifactRetentionDays: 7,
      maxExportRows: 50_000,
      revision: 1,
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'snapshot policy caps',
        to: window.to,
      },
    });

    expect(created.filterSnapshot).toMatchObject({
      exportArtifactRetentionDays: 7,
      maxExportRows: 50_000,
      policyRevision: 1,
    });

    // Mutate live policy after create — worker must still honor freeze.
    await serverDB
      .update(platformAuditPolicies)
      .set({ exportArtifactRetentionDays: 1, maxExportRows: 1, revision: 99 })
      .where(eq(platformAuditPolicies.id, 'global'));

    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'a',
        createdAt: new Date('2026-01-05T10:00:00.000Z'),
        id: 'op-snap-a',
        result: 'success',
        targetType: 'x',
      },
      {
        action: 'b',
        createdAt: new Date('2026-01-05T11:00:00.000Z'),
        id: 'op-snap-b',
        result: 'success',
        targetType: 'x',
      },
    ]);

    // Live maxExportRows=1 would fail; frozen 50_000 must complete both rows.
    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-snap',
    });
    expect(result.outcome).toBe('completed');

    const got = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(got.status).toBe('completed');
    expect(got.rowCount).toBe(2);
    // Retention from freeze (7d), not live (1d)
    expect(got.expiresAt).toBeTruthy();
    const days =
      (got.expiresAt!.getTime() - (got.finishedAt ?? new Date()).getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(5);
  });

  it('terminal-fails invalid frozen from/to without artifact (never widens scan)', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'corrupt frozen dates',
        to: window.to,
      },
    });

    // Corrupt frozen window after create — invalid present values must not become undefined.
    await serverDB
      .update(platformAuditExports)
      .set({
        filterSnapshot: {
          exportArtifactRetentionDays: 7,
          from: 'not-a-date',
          maxExportRows: 1000,
          policyRevision: 0,
          to: window.to.toISOString(),
        },
      })
      .where(eq(platformAuditExports.id, created.id));

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-bad-date',
    });
    expect(result.outcome).toBe('failed');

    const got = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(got.status).toBe('failed');
    expect(got.error?.code).toBe('INVALID_FILTER_SNAPSHOT');
    expect(storage.objects.size).toBe(0);
  });

  it('terminal-fails present non-positive / over-bound frozen maxExportRows without artifact', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'corrupt frozen cap',
        to: window.to,
      },
    });

    await serverDB
      .update(platformAuditExports)
      .set({
        filterSnapshot: {
          exportArtifactRetentionDays: 7,
          from: window.from.toISOString(),
          // Present but invalid: must terminal-fail, not fall back to live policy.
          maxExportRows: 0,
          policyRevision: 0,
          to: window.to.toISOString(),
        },
      })
      .where(eq(platformAuditExports.id, created.id));

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-bad-cap',
    });
    expect(result.outcome).toBe('failed');

    const got = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(got.status).toBe('failed');
    expect(got.error?.code).toBe('INVALID_FILTER_SNAPSHOT');
    expect(storage.objects.size).toBe(0);
  });

  it('terminal-fails conversations export missing frozen userId without artifact', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all', 'platform_audit:conversation_read:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'conversations',
        reason: 'missing userId after create',
        to: window.to,
        userId: userA,
      },
    });

    await serverDB
      .update(platformAuditExports)
      .set({
        filterSnapshot: {
          exportArtifactRetentionDays: 7,
          from: window.from.toISOString(),
          maxExportRows: 1000,
          policyRevision: 0,
          to: window.to.toISOString(),
          // userId intentionally omitted
        },
      })
      .where(eq(platformAuditExports.id, created.id));

    const result = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'test-worker-no-user',
    });
    expect(result.outcome).toBe('failed');

    const got = await service.get({
      actorPermissions: ['platform_audit:export:all', 'platform_audit:conversation_read:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(got.status).toBe('failed');
    expect(got.error?.code).toBe('INVALID_FILTER_SNAPSHOT');
    expect(storage.objects.size).toBe(0);
  });

  it('retries transient storage errors without terminal-failing the export domain', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      createdAt: new Date('2026-01-05T12:00:00.000Z'),
      id: 'op-retry-1',
      result: 'success',
      targetType: 'settings',
    });

    let uploads = 0;
    const flakyStorage = {
      deleteObject: async (key: string) => {
        storage.objects.delete(key);
      },
      getObjectBytes: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return Buffer.from(body);
      },
      getObjectMetadata: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return { contentLength: body.byteLength, contentType: 'application/x-ndjson' };
      },
      getSignedDownloadUrl: async () => 'https://audit-export.test/signed/x',
      uploadArtifact: async (params: {
        body: Buffer;
        contentType?: string;
        storageKey: string;
      }) => {
        uploads += 1;
        if (uploads === 1) {
          throw new Error('S3_TRANSIENT_TIMEOUT');
        }
        storage.objects.set(params.storageKey, Buffer.from(params.body));
        return {
          artifactBytes: params.body.byteLength,
          artifactChecksum: formatArtifactChecksum(sha256Hex(params.body)),
          storageKey: params.storageKey,
        };
      },
    };

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'retry transient',
        to: window.to,
      },
    });

    const first = await processNextAuditExportJob(serverDB, {
      storage: flakyStorage,
      workerId: 'test-worker-retry',
    });
    expect(first.outcome).toBe('retry');

    // Domain stays running (not failed); job requeued pending for retry.
    const mid = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(mid.status).toBe('running');
    expect(mid.error).toBeNull();

    if (created.jobId) {
      const [job] = await serverDB
        .select()
        .from(platformJobs)
        .where(eq(platformJobs.id, created.jobId));
      expect(job?.status).toBe('pending');
    }

    // No partial artifact retained after failed attempt
    expect(storage.objects.size).toBe(0);

    const second = await processNextAuditExportJob(serverDB, {
      storage: flakyStorage,
      workerId: 'test-worker-retry',
    });
    expect(second.outcome).toBe('completed');

    const done = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(done.status).toBe('completed');
    expect(done.rowCount).toBe(1);
  });

  it('final jobs.complete lease loss does not report clean completion or cancel export', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      createdAt: new Date('2026-01-05T12:00:00.000Z'),
      id: 'op-final-lease-1',
      result: 'success',
      targetType: 'settings',
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'final complete lease loss',
        to: window.to,
      },
    });
    const jobId = created.jobId!;

    const result = await processNextAuditExportJob(serverDB, {
      afterDomainComplete: async () => {
        // Steal lease after domain terminal complete, before jobs.complete ownership check.
        await serverDB
          .update(platformJobs)
          .set({
            leaseOwner: 'thief',
            leaseUntil: new Date(Date.now() + 120_000),
          })
          .where(eq(platformJobs.id, jobId));
      },
      storage,
      workerId: 'export-final-lease-loser',
    });

    expect(result.outcome).toBe('skipped');
    expect(result.outcome).not.toBe('completed');
    expect(result.outcome).not.toBe('cancelled');

    const got = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    // Domain completed; lease loss must not cancel or strip the artifact.
    expect(got.status).toBe('completed');
    expect(got.status).not.toBe('cancelled');
    expect(storage.objects.has(buildAuditExportStorageKey(created.id))).toBe(true);

    const [job] = await serverDB.select().from(platformJobs).where(eq(platformJobs.id, jobId));
    expect(job?.status).toBe('running');
    expect(job?.status).not.toBe('succeeded');
    expect(job?.status).not.toBe('cancelled');
    expect(job?.leaseOwner).toBe('thief');
  });
});
