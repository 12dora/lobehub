// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformJobModel } from '@/database/models/platform';
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
  AdminAuditRetentionService,
  AuditExportLeaseLostError,
  buildAuditExportStorageKey,
  formatArtifactChecksum,
  InMemoryAuditExportArtifactStorage,
  processNextAuditExportJob,
  processNextAuditRetentionJob,
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
      hashObject: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: formatArtifactChecksum(sha256Hex(body)),
        };
      },
      uploadArtifact: async (params: {
        artifactChecksum?: string;
        body: Buffer | NodeJS.ReadableStream;
        contentLength?: number;
        contentType?: string;
        storageKey: string;
      }) => {
        uploads += 1;
        if (uploads === 1) {
          throw new Error('S3_TRANSIENT_TIMEOUT');
        }
        let body: Buffer;
        if (Buffer.isBuffer(params.body)) {
          body = Buffer.from(params.body);
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of params.body as AsyncIterable<Buffer | Uint8Array | string>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          body = Buffer.concat(chunks);
        }
        storage.objects.set(params.storageKey, body);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: params.artifactChecksum ?? formatArtifactChecksum(sha256Hex(body)),
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

  it('F6: dead-lettered export after upload still purges object (delete-fails-once)', async () => {
    // Regression: claimNext dead-letters a final-attempt lease-expired worker
    // without the export worker cleanup path. Cleanup intent recorded at upload
    // + retention reconcile must still drain the private object.
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      createdAt: new Date('2026-01-05T12:00:00.000Z'),
      id: 'op-f6-dead-letter',
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
        reason: 'f6 dead letter after upload',
        to: window.to,
      },
    });
    const jobId = created.jobId!;
    const storageKey = buildAuditExportStorageKey(created.id);

    // Final attempt only: lease-expiry after claim must dead-letter (not reclaim).
    await serverDB.update(platformJobs).set({ maxAttempts: 1 }).where(eq(platformJobs.id, jobId));

    // Upload succeeds, then process dies (lease-loss path leaves domain running).
    const crashed = await processNextAuditExportJob(serverDB, {
      afterArtifactUpload: async () => {
        throw new AuditExportLeaseLostError();
      },
      storage,
      workerId: 'export-f6-crash',
    });
    expect(crashed.outcome).toBe('skipped');
    expect(storage.objects.has(storageKey)).toBe(true);

    // Upload-time purge intent is durable on the still-running domain row.
    const [midRow] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(midRow?.status).toBe('running');
    expect(midRow?.error?.purgeStorageKey).toBe(storageKey);

    // Expire lease; claimNext dead-letters without invoking export cleanup.
    await serverDB
      .update(platformJobs)
      .set({
        leaseOwner: 'export-f6-crash',
        leaseUntil: new Date(Date.now() - 60_000),
        status: 'running',
      })
      .where(eq(platformJobs.id, jobId));

    const jobs = new PlatformJobModel(serverDB);
    const reclaimed = await jobs.claimNext({
      types: ['platform.audit.export.v1'],
      workerId: 'export-f6-reclaimer',
    });
    expect(reclaimed).toBeNull();

    const [deadJob] = await serverDB.select().from(platformJobs).where(eq(platformJobs.id, jobId));
    expect(deadJob?.status).toBe('dead');

    // Domain still running — worker cleanup never ran.
    const [stillRunning] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(stillRunning?.status).toBe('running');
    expect(storage.objects.has(storageKey)).toBe(true);

    // Retention: first object delete fails once, then succeeds (outbox retry).
    let deletes = 0;
    const flakyDeleteStorage = {
      deleteObject: async (key: string) => {
        deletes += 1;
        if (deletes === 1) throw new Error('S3_TRANSIENT_DELETE');
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
      hashObject: async (key: string) => {
        const body = storage.objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: formatArtifactChecksum(sha256Hex(body)),
        };
      },
      uploadArtifact: async () => {
        throw new Error('upload not used');
      },
    };

    const retention = new AdminAuditRetentionService(serverDB, { storage: flakyDeleteStorage });
    await retention.run({
      actorUserId: actor,
      input: { reason: 'f6 purge dead-lettered export', scope: 'export_artifacts' },
    });

    // First retention attempt may fail on delete; drain retries until outbox clears.
    for (let i = 0; i < 6; i++) {
      const r = await processNextAuditRetentionJob(serverDB, {
        storage: flakyDeleteStorage,
        workerId: `ret-f6-${i}`,
      });
      if (!r.claimed && storage.objects.size === 0) break;
    }

    expect(deletes).toBeGreaterThanOrEqual(2);
    expect(storage.objects.has(storageKey)).toBe(false);

    const [finalRow] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(finalRow?.status).toBe('failed');
    expect(finalRow?.storageKey).toBeNull();
    expect(finalRow?.error?.purgeStorageKey).toBeFalsy();
    expect(finalRow?.error?.code).toBe('EXPORT_FAILED');
  });

  it('F10: streaming upload/hash — rejects Buffer path and forbids getObjectBytes', async () => {
    // Explicit small buffering threshold: full Buffer uploads are rejected outright.
    // Artifact is forced larger than createReadStream's default highWaterMark (64 KiB)
    // so a multi-chunk stream is observable; a reverted worker that does
    // readFile()+upload(Buffer) / getObjectBytes() fails hard (no conditional skip).
    const BUFFERING_THRESHOLD_BYTES = 4 * 1024;
    const STREAM_HIGH_WATER_MARK = 64 * 1024;
    // Payload alone exceeds both the mock threshold and the stream window.
    const payload = 'x'.repeat(STREAM_HIGH_WATER_MARK + BUFFERING_THRESHOLD_BYTES);

    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.settings.publish',
      afterDiff: { big: payload },
      createdAt: new Date('2026-01-05T12:00:00.000Z'),
      id: 'op-f10-stream',
      result: 'success',
      targetType: 'settings',
    });

    const objects = new Map<string, Buffer>();
    let streamUploadCount = 0;
    let hashObjectCount = 0;
    let peakStreamChunkBytes = 0;

    const streamOnlyStorage = {
      deleteObject: async (key: string) => {
        objects.delete(key);
      },
      getObjectBytes: async (_key: string): Promise<Buffer> => {
        // Download / post-upload verify must use hashObject streaming (F10).
        throw new Error('GET_OBJECT_BYTES_FORBIDDEN: use hashObject streaming path');
      },
      getObjectMetadata: async (key: string) => {
        const body = objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        return { contentLength: body.byteLength, contentType: 'application/x-ndjson' };
      },
      getSignedDownloadUrl: async (key: string) =>
        `https://audit-export.test/signed/${encodeURIComponent(key)}`,
      hashObject: async (key: string) => {
        hashObjectCount += 1;
        const body = objects.get(key);
        if (!body) throw new Error(`Object not found: ${key}`);
        // Simulate streaming windows: digest must still match one-shot sha256Hex.
        let offset = 0;
        const window = 1024;
        const parts: Buffer[] = [];
        while (offset < body.byteLength) {
          parts.push(body.subarray(offset, Math.min(offset + window, body.byteLength)));
          offset += window;
        }
        const reassembled = Buffer.concat(parts);
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: formatArtifactChecksum(sha256Hex(reassembled)),
        };
      },
      uploadArtifact: async (params: {
        artifactChecksum?: string;
        body: Buffer | NodeJS.ReadableStream;
        contentLength?: number;
        contentType?: string;
        storageKey: string;
      }) => {
        if (Buffer.isBuffer(params.body)) {
          // Reverted worker path materializes the full artifact as a Buffer.
          throw new Error(
            `BUFFER_UPLOAD_REJECTED: full Buffer upload (${params.body.byteLength} bytes) — must stream`,
          );
        }
        streamUploadCount += 1;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of params.body as AsyncIterable<Buffer | Uint8Array | string>) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          peakStreamChunkBytes = Math.max(peakStreamChunkBytes, buf.byteLength);
          chunks.push(buf);
          total += buf.byteLength;
        }
        if (total <= BUFFERING_THRESHOLD_BYTES) {
          throw new Error(
            `ARTIFACT_TOO_SMALL: ${total} bytes — regression requires > ${BUFFERING_THRESHOLD_BYTES}`,
          );
        }
        const body = Buffer.concat(chunks, total);
        objects.set(params.storageKey, body);
        const checksum = params.artifactChecksum ?? formatArtifactChecksum(sha256Hex(body));
        return {
          artifactBytes: body.byteLength,
          artifactChecksum: formatArtifactChecksum(checksum),
          storageKey: params.storageKey,
        };
      },
    };

    const service = new AdminAuditExportService(serverDB, { storage: streamOnlyStorage });
    const created = await service.create({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'f10 stream upload',
        to: window.to,
      },
    });

    const result = await processNextAuditExportJob(serverDB, {
      // Cap is well above the artifact — only used as an injected seam (not a skip gate).
      maxArtifactBytes: 2 * 1024 * 1024,
      storage: streamOnlyStorage,
      workerId: 'export-f10-stream',
    });
    expect(result.outcome).toBe('completed');
    expect(streamUploadCount).toBe(1);
    // Post-upload integrity must call hashObject (getObjectBytes throws).
    expect(hashObjectCount).toBeGreaterThanOrEqual(1);

    const key = buildAuditExportStorageKey(created.id);
    const body = objects.get(key);
    expect(body).toBeTruthy();
    expect(body!.byteLength).toBeGreaterThan(BUFFERING_THRESHOLD_BYTES);
    expect(body!.byteLength).toBeGreaterThan(STREAM_HIGH_WATER_MARK);
    // Stream chunks must stay under the full artifact (createReadStream windows).
    // Unconditionally asserted — artifact is sized above highWaterMark so this
    // fails if the producer handed over one materialized Buffer-sized chunk.
    expect(peakStreamChunkBytes).toBeGreaterThan(0);
    expect(peakStreamChunkBytes).toBeLessThanOrEqual(STREAM_HIGH_WATER_MARK);
    expect(peakStreamChunkBytes).toBeLessThan(body!.byteLength);

    const expectedChecksum = formatArtifactChecksum(sha256Hex(body!));
    const got = await service.get({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      id: created.id,
    });
    expect(got.artifactChecksum).toBe(expectedChecksum);
    expect(got.artifactBytes).toBe(body!.byteLength);

    // Stream-hash verification matches the stored checksum (same as one-shot).
    const hashed = await streamOnlyStorage.hashObject(key);
    expect(hashed.artifactChecksum).toBe(expectedChecksum);
    expect(hashed.artifactBytes).toBe(body!.byteLength);

    const hashBeforeDownload = hashObjectCount;
    // Download integrity also stream-hashes — getObjectBytes would throw.
    const dl = await service.download({
      actorPermissions: ['platform_audit:export:all'],
      actorUserId: actor,
      input: { id: created.id, reason: 'f10 download stream verify' },
    });
    expect(dl.artifactChecksum).toBe(got.artifactChecksum);
    expect(hashObjectCount).toBeGreaterThan(hashBeforeDownload);
  });

  it('F12: disabled content-access policy fails create/execute/download closed', async () => {
    const perms = ['platform_audit:export:all', 'platform_audit:conversation_read:all'] as const;
    const service = new AdminAuditExportService(serverDB, { storage });

    // Create under disabled policy — conversation surfaces fail closed.
    await serverDB.insert(platformAuditPolicies).values({
      contentAccessMode: 'disabled',
      id: 'global',
      revision: 0,
    });

    await expect(
      service.create({
        actorPermissions: perms,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'conversations',
          reason: 'disabled create',
          to: window.to,
          userId: userA,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      service.create({
        actorPermissions: perms,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'user_timeline',
          reason: 'disabled timeline create',
          to: window.to,
          userId: userA,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Queue a conversations export while access is allowed, then flip the kill-switch.
    await serverDB
      .update(platformAuditPolicies)
      .set({ contentAccessMode: 'metadata_only', revision: 1 })
      .where(eq(platformAuditPolicies.id, 'global'));

    const queued = await service.create({
      actorPermissions: perms,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'conversations',
        reason: 'queued before revoke',
        to: window.to,
        userId: userA,
      },
    });

    await serverDB
      .update(platformAuditPolicies)
      .set({ contentAccessMode: 'disabled', revision: 2 })
      .where(eq(platformAuditPolicies.id, 'global'));

    // Execute: worker rechecks live policy and terminal-fails without reading evidence.
    const executed = await processNextAuditExportJob(serverDB, {
      storage,
      workerId: 'export-f12-disabled',
    });
    expect(executed.outcome).toBe('failed');

    const afterFail = await service.get({
      actorPermissions: perms,
      actorUserId: actor,
      id: queued.id,
    });
    expect(afterFail.status).toBe('failed');
    expect(afterFail.error?.code).toBe('CONTENT_ACCESS_DISABLED');
    expect(storage.objects.size).toBe(0);

    // Download: completed conversation artifact also fails closed under disabled policy.
    const storageKey = buildAuditExportStorageKey(queued.id);
    const body = Buffer.from('{"type":"manifest"}\n');
    storage.objects.set(storageKey, body);
    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: body.byteLength,
        artifactChecksum: formatArtifactChecksum(sha256Hex(body)),
        error: null,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey,
      })
      .where(eq(platformAuditExports.id, queued.id));

    await expect(
      service.download({
        actorPermissions: perms,
        actorUserId: actor,
        input: { id: queued.id, reason: 'disabled download' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // F12 concurrent same-key create/publish race (one export + one job) lives in
  // exportPublication.multiconn.pg.test.ts — PGlite cannot prove multi-connection publication dedup.
});
