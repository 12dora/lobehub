// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAuditExports,
  platformAuditLegalHolds,
  platformJobs,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditExportModel } from '../platform/auditExport';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditExportModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformAuditLegalHolds);
  await serverDB.delete(platformJobs);
});

describe('PlatformAuditExportModel', () => {
  it('creates with typed filter snapshot, includesMessageBodies, and pending status', async () => {
    const row = await model.create({
      filterSnapshot: {
        actorUserId: 'user-a',
        from: '2026-01-01T00:00:00.000Z',
        result: 'success',
      },
      includesMessageBodies: true,
      kind: 'operation_logs',
      requestedBy: 'admin-1',
    });

    expect(row.id).toMatch(/^paex_/);
    expect(row.status).toBe('pending');
    expect(row.kind).toBe('operation_logs');
    expect(row.includesMessageBodies).toBe(true);
    expect(row.filterSnapshot).toMatchObject({ actorUserId: 'user-a', result: 'success' });
    expect(row.requestedBy).toBe('admin-1');
    expect(row.storageKey).toBeNull();
  });

  it('setJobId links a platform job while pending', async () => {
    const row = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    const linked = await model.setJobId(row.id, 'pjob_link_1');
    expect(linked?.jobId).toBe('pjob_link_1');
    // re-affirm same job
    const again = await model.setJobId(row.id, 'pjob_link_1');
    expect(again?.jobId).toBe('pjob_link_1');
  });

  it('requires non-null requestedBy on create', async () => {
    await expect(
      model.create({
        kind: 'operation_logs',
        // Empty string is typed as string but rejected at runtime.
        requestedBy: '',
      }),
    ).rejects.toThrow(/requestedBy is required/);
  });

  it('supports full lifecycle markRunning → complete with storageKey (never artifactUrl)', async () => {
    const created = await model.create({ kind: 'conversations', requestedBy: 'admin-1' });

    const running = await model.markRunning(created.id, { jobId: 'pjob_export_1' });
    expect(running?.status).toBe('running');
    expect(running?.jobId).toBe('pjob_export_1');
    expect(running?.startedAt).toBeInstanceOf(Date);

    const attemptToken = 'pjob_export_1:1';
    await model.bindPublicationAttempt(created.id, attemptToken);

    const expiresAt = new Date('2026-08-01T00:00:00.000Z');
    const completed = await model.complete(created.id, {
      artifactBytes: 1024,
      artifactChecksum: 'sha256:abc',
      attemptToken,
      expiresAt,
      rowCount: 42,
      storageKey: 'audit-exports/paex/export.jsonl',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.artifactChecksum).toBe('sha256:abc');
    expect(completed?.storageKey).toBe('audit-exports/paex/export.jsonl');
    expect(completed?.artifactBytes).toBe(1024);
    expect(completed?.rowCount).toBe(42);
    expect(completed?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(completed?.finishedAt).toBeInstanceOf(Date);
    // contract: no signed URL field on the row
    expect((completed as { artifactUrl?: unknown }).artifactUrl).toBeUndefined();
  });

  it('complete is fenced on attemptToken and requires checksum, storageKey, expiresAt', async () => {
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'tok-a');

    await expect(
      model.complete(created.id, {
        artifactChecksum: '',
        attemptToken: 'tok-a',
        expiresAt: new Date(),
        storageKey: 'k',
      }),
    ).rejects.toThrow(/artifactChecksum/);

    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        attemptToken: 'tok-a',
        expiresAt: new Date(),
        storageKey: '',
      }),
    ).rejects.toThrow(/storageKey/);

    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        attemptToken: '',
        expiresAt: new Date(),
        storageKey: 'k',
      }),
    ).rejects.toThrow(/attemptToken/);

    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        attemptToken: 'tok-a',
        // @ts-expect-error intentional
        expiresAt: null,
        storageKey: 'k',
      }),
    ).rejects.toThrow(/expiresAt/);

    // Wrong fencing token loses publication.
    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        attemptToken: 'tok-other',
        expiresAt: new Date(),
        storageKey: 'k',
      }),
    ).resolves.toBeUndefined();
  });

  it('enforces unique jobId when set', async () => {
    await model.create({
      jobId: 'pjob_shared',
      kind: 'operation_logs',
      requestedBy: 'admin-1',
    });
    await expect(
      model.create({
        jobId: 'pjob_shared',
        kind: 'conversations',
        requestedBy: 'admin-2',
      }),
    ).rejects.toThrow();
  });

  it('fails / cancels only from pending|running and supports expired', async () => {
    const a = await model.create({ kind: 'user_timeline', requestedBy: 'admin-1' });
    const failed = await model.fail(a.id, { code: 'WORKER_ERROR', message: 'boom' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatchObject({ code: 'WORKER_ERROR' });

    // already terminal — cancel is a no-op
    await expect(model.cancel(a.id)).resolves.toBeUndefined();

    const b = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    const cancelled = await model.cancel(b.id);
    expect(cancelled?.status).toBe('cancelled');

    const c = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(c.id);
    await model.bindPublicationAttempt(c.id, 'tok-c');
    const completed = await model.complete(c.id, {
      artifactChecksum: 'x',
      attemptToken: 'tok-c',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      storageKey: 'audit-exports/c.jsonl',
    });
    expect(completed?.status).toBe('completed');
    const expired = await model.expired(c.id);
    expect(expired?.status).toBe('expired');
    // idempotent
    const expiredAgain = await model.expired(c.id);
    expect(expiredAgain?.status).toBe('expired');
  });

  it('lists with filters, pagination (limit 1..200), and requestedBy isolation', async () => {
    const t0 = new Date('2026-07-01T00:00:00.000Z');
    await serverDB.insert(platformAuditExports).values([
      {
        createdAt: t0,
        id: 'paex_0000000000000003',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'pending',
      },
      {
        createdAt: t0,
        id: 'paex_0000000000000002',
        kind: 'conversations',
        requestedBy: 'admin-2',
        status: 'running',
      },
      {
        createdAt: t0,
        id: 'paex_0000000000000001',
        kind: 'operation_logs',
        requestedBy: 'admin-1',
        status: 'completed',
        storageKey: 'k',
        artifactChecksum: 'c',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);

    const admin1 = await model.list({ limit: 10, requestedBy: 'admin-1' });
    expect(admin1.items.map((r) => r.id)).toEqual([
      'paex_0000000000000003',
      'paex_0000000000000001',
    ]);
    expect(admin1.items.every((r) => r.requestedBy === 'admin-1')).toBe(true);

    const page1 = await model.list({ kind: 'operation_logs', limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await model.list({
      cursor: page1.nextCursor!,
      kind: 'operation_logs',
      limit: 10,
    });
    expect(page2.items.map((r) => r.id)).toEqual(['paex_0000000000000001']);
    expect(page2.nextCursor).toBeNull();

    // limit clamps: 0 → 1, oversized → 200
    const clampedLow = await model.list({ limit: 0 });
    expect(clampedLow.items.length).toBeGreaterThanOrEqual(1);
    const clampedHigh = await model.list({ limit: 999 });
    expect(clampedHigh.items.length).toBeLessThanOrEqual(200);
  });

  it('get returns undefined for missing ids', async () => {
    await expect(model.get('paex_missing')).resolves.toBeUndefined();
  });

  it('clearArtifactStorage clears storageKey, sets expired, preserves finishedAt and metadata', async () => {
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'tok-clear');
    const finishedAt = new Date('2026-03-15T12:00:00.000Z');
    const completed = await model.complete(created.id, {
      artifactBytes: 99,
      artifactChecksum: 'sha256:keep-me',
      attemptToken: 'tok-clear',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      rowCount: 3,
      storageKey: 'audit-exports/keep/meta.jsonl',
    });
    // Pin a known completion time (complete() stamps now).
    await serverDB
      .update(platformAuditExports)
      .set({ finishedAt })
      .where(eq(platformAuditExports.id, created.id));

    const cleared = await model.clearArtifactStorage(created.id);
    expect(cleared?.status).toBe('expired');
    expect(cleared?.storageKey).toBeNull();
    expect(cleared?.artifactChecksum).toBe('sha256:keep-me');
    expect(cleared?.artifactBytes).toBe(99);
    expect(cleared?.rowCount).toBe(3);
    expect(cleared?.filterSnapshot).toEqual(completed?.filterSnapshot ?? {});
    expect(cleared?.finishedAt?.toISOString()).toBe(finishedAt.toISOString());

    // Idempotent clear on already-expired row with null key
    const again = await model.clearArtifactStorage(created.id);
    expect(again?.status).toBe('expired');
    expect(again?.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
  });

  it('DB-002: dead-letter reconcile atomically fails + enqueues purge (no failed+storageKey intermediate)', async () => {
    // Seed a dead job + running export that already uploaded.
    await serverDB.insert(platformJobs).values({
      attempt: 1,
      id: 'pjob_dead_export_1',
      idempotencyKey: 'dead-export-1',
      maxAttempts: 1,
      status: 'dead',
      type: 'platform.audit.export.v1',
    });
    const created = await model.create({
      jobId: 'pjob_dead_export_1',
      kind: 'operation_logs',
      requestedBy: 'admin-1',
    });
    await model.markRunning(created.id, { jobId: 'pjob_dead_export_1' });
    await serverDB
      .update(platformAuditExports)
      .set({
        error: {
          attemptToken: 't1',
          code: 'ARTIFACT_PURGE_PENDING',
          purgeStatus: 'pending',
          purgeStorageKey: 'attempt-key/x',
        },
        status: 'running',
        storageKey: null,
      })
      .where(eq(platformAuditExports.id, created.id));

    // Also seed a row with storageKey still set (upload completed path without intent).
    await serverDB.insert(platformJobs).values({
      attempt: 1,
      id: 'pjob_dead_export_2',
      idempotencyKey: 'dead-export-2',
      maxAttempts: 1,
      status: 'dead',
      type: 'platform.audit.export.v1',
    });
    const withKey = await model.create({
      jobId: 'pjob_dead_export_2',
      kind: 'operation_logs',
      requestedBy: 'admin-1',
    });
    await model.markRunning(withKey.id, { jobId: 'pjob_dead_export_2' });
    await serverDB
      .update(platformAuditExports)
      .set({ status: 'running', storageKey: 'live-key/y' })
      .where(eq(platformAuditExports.id, withKey.id));

    const n = await model.reconcileDeadLetterExportArtifacts({
      buildStorageKey: (id) => `fallback/${id}`,
      limit: 50,
    });
    expect(n).toBeGreaterThanOrEqual(2);

    const rows = await serverDB.select().from(platformAuditExports);
    for (const row of rows) {
      if (row.id === created.id || row.id === withKey.id) {
        expect(row.status).toBe('failed');
        // Never stranded failed + storageKey non-null
        expect(row.storageKey).toBeNull();
        expect(row.error?.purgeStorageKey).toBeTruthy();
      }
    }

    const pending = await model.listPendingArtifactPurges({ limit: 50 });
    expect(pending.some((p) => p.id === created.id)).toBe(true);
    expect(pending.some((p) => p.id === withKey.id)).toBe(true);
  });

  it('DB-001: two-phase purge — deleteObject success + finalize failure leaves deleting; scoped hold rejects; non-intersecting succeeds', async () => {
    const { PlatformAuditLegalHoldModel } = await import('../platform/auditLegalHold');
    const { LegalHoldPurgeInProgressError } = await import('../platform/auditExport');
    const created = await model.create({
      filterSnapshot: { userId: 'user-held-by-purge' },
      kind: 'conversations',
      requestedBy: 'admin-1',
    });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'tok-purge');
    await model.complete(created.id, {
      artifactChecksum: 'sha256:p',
      attemptToken: 'tok-purge',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      storageKey: 'purge-key/z',
    });
    // Claim into purge outbox
    const claimed = await model.claimArtifactStorageForPurge(
      created.id,
      undefined,
      'retention-run-1',
    );
    expect(claimed?.storageKey).toBe('purge-key/z');
    const pending = await model.listPendingArtifactPurges({ limit: 10 });
    expect(pending.find((item) => item.id === created.id)?.purgeRunId).toBe('retention-run-1');

    // Phase 1 under lock; external delete succeeds; finalize is NOT called (crash).
    const phase1 = await model.authorizeAndMarkDeletingUnderHoldLock([created.id], {
      resolveHeldIds: async () => new Set(),
    });
    expect(phase1.authorized).toHaveLength(1);
    expect(phase1.authorized[0]!.storageKey).toBe('purge-key/z');
    // Object destroyed externally; DB still `deleting`.

    const [mid] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(mid?.error?.purgeStatus).toBe('deleting');
    expect(mid?.error?.purgeToken).toBeTruthy();

    const holds = new PlatformAuditLegalHoldModel(serverDB);

    // Intersecting hold (same user) must reject with typed purge-in-progress error.
    await expect(
      holds.create({
        createdBy: 'admin-hold',
        reason: 'must reject while deleting intersecting',
        scopeId: 'user-held-by-purge',
        scopeType: 'user',
      }),
    ).rejects.toThrow(LegalHoldPurgeInProgressError);

    // Non-intersecting hold (different user) must still succeed while deleting is open.
    const other = await holds.create({
      createdBy: 'admin-hold',
      reason: 'unrelated scope while purge runs',
      scopeId: 'user-other-scope',
      scopeType: 'user',
    });
    expect(other.status).toBe('active');

    // Self-heal: objectExists=false finalizes the stranded deleting row, then hold works.
    const healed = await holds.create({
      createdBy: 'admin-hold',
      objectExists: async () => false,
      reason: 'self-heal then create',
      scopeId: 'user-held-by-purge',
      scopeType: 'user',
    });
    expect(healed.status).toBe('active');

    const [done] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(done?.error?.purgeStorageKey).toBeFalsy();
    expect(done?.error?.purgeStatus).toBeFalsy();
  });

  it('R2: recordArtifactUploadIntent appends keys — attempt rebind retains both for purge', async () => {
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'tok-a1');
    await model.recordArtifactUploadIntent(created.id, 'attempts/job_1/evidence.ndjson', serverDB, {
      attemptToken: 'tok-a1',
    });
    // Rebind to attempt 2 and record a new key — must not drop attempt 1.
    await model.bindPublicationAttempt(created.id, 'tok-a2');
    await model.recordArtifactUploadIntent(created.id, 'attempts/job_2/evidence.ndjson', serverDB, {
      attemptToken: 'tok-a2',
    });
    const [row] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    const keys = [...(row?.error?.purgeStorageKeys ?? []), row?.error?.purgeStorageKey].filter(
      Boolean,
    );
    expect(keys).toEqual(
      expect.arrayContaining(['attempts/job_1/evidence.ndjson', 'attempts/job_2/evidence.ndjson']),
    );

    // Fail + purge both keys.
    await model.fail(created.id, { code: 'EXPORT_FAILED' });
    const pending = await model.listPendingArtifactPurges({ limit: 10 });
    expect(pending.some((p) => p.id === created.id)).toBe(true);

    const result = await model.purgeArtifactObjectsUnderHoldLock([created.id], {
      deleteObject: async () => undefined,
      objectExists: async () => false,
      resolveHeldIds: async () => new Set(),
    });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const [after] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(after?.error?.purgeStorageKey).toBeFalsy();
    expect(after?.error?.purgeStorageKeys?.length ?? 0).toBe(0);
  });

  it('SAO-002 R1: complete() retains orphan attempt-1 key after crash-retry success', async () => {
    // Attempt 1 intent → rebind + attempt 2 intent → attempt 2 completes.
    // Attempt 1 object must stay purge-tracked and be drained (not wiped by error:null).
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'tok-a1');
    await model.recordArtifactUploadIntent(created.id, 'attempts/job_1/evidence.ndjson', serverDB, {
      attemptToken: 'tok-a1',
    });
    await model.bindPublicationAttempt(created.id, 'tok-a2');
    await model.recordArtifactUploadIntent(created.id, 'attempts/job_2/evidence.ndjson', serverDB, {
      attemptToken: 'tok-a2',
    });

    const completed = await model.complete(created.id, {
      artifactBytes: 12,
      artifactChecksum: 'sha256:deadbeef',
      attemptToken: 'tok-a2',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      storageKey: 'attempts/job_2/evidence.ndjson',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.storageKey).toBe('attempts/job_2/evidence.ndjson');
    // Published key is live; orphan attempt-1 remains on the outbox.
    expect(completed?.error?.purgeStorageKeys).toEqual(['attempts/job_1/evidence.ndjson']);
    expect(completed?.error?.purgeStorageKey).toBe('attempts/job_1/evidence.ndjson');
    expect(completed?.error?.purgeStatus).toBe('pending');
    expect(completed?.error?.attemptToken).toBeUndefined();

    const pending = await model.listPendingArtifactPurges({ limit: 20 });
    const mine = pending.filter((p) => p.id === created.id);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.map((p) => p.storageKey)).toContain('attempts/job_1/evidence.ndjson');
    // Live published key must not be scheduled for purge.
    expect(mine.map((p) => p.storageKey)).not.toContain('attempts/job_2/evidence.ndjson');

    const deletedKeys: string[] = [];
    const result = await model.purgeArtifactObjectsUnderHoldLock([created.id], {
      deleteObject: async (key) => {
        deletedKeys.push(key);
      },
      objectExists: async () => false,
      resolveHeldIds: async () => new Set(),
    });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(deletedKeys).toContain('attempts/job_1/evidence.ndjson');
    expect(deletedKeys).not.toContain('attempts/job_2/evidence.ndjson');

    const [after] = await serverDB
      .select()
      .from(platformAuditExports)
      .where(eq(platformAuditExports.id, created.id));
    expect(after?.status).toBe('completed');
    expect(after?.storageKey).toBe('attempts/job_2/evidence.ndjson');
    expect(after?.error?.purgeStorageKey).toBeFalsy();
    expect(after?.error?.purgeStorageKeys?.length ?? 0).toBe(0);
  });

  it('fencing: complete with wrong attemptToken returns undefined (no publication)', async () => {
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);
    await model.bindPublicationAttempt(created.id, 'owner-token');
    const lost = await model.complete(created.id, {
      artifactChecksum: 'sha256:x',
      attemptToken: 'loser-token',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      storageKey: 'loser-key',
    });
    expect(lost).toBeUndefined();
    const won = await model.complete(created.id, {
      artifactChecksum: 'sha256:x',
      attemptToken: 'owner-token',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      storageKey: 'winner-key',
    });
    expect(won?.status).toBe('completed');
    expect(won?.storageKey).toBe('winner-key');
  });
});
