// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditExports } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditExportModel } from '../platform/auditExport';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditExportModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditExports);
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

  it('requires non-null requestedBy on create', async () => {
    await expect(
      model.create({
        kind: 'operation_logs',
        // @ts-expect-error intentional contract violation
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

    const expiresAt = new Date('2026-08-01T00:00:00.000Z');
    const completed = await model.complete(created.id, {
      artifactBytes: 1024,
      artifactChecksum: 'sha256:abc',
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

  it('complete requires checksum, storageKey, and expiresAt', async () => {
    const created = await model.create({ kind: 'operation_logs', requestedBy: 'admin-1' });
    await model.markRunning(created.id);

    await expect(
      model.complete(created.id, {
        artifactChecksum: '',
        expiresAt: new Date(),
        storageKey: 'k',
      }),
    ).rejects.toThrow(/artifactChecksum/);

    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        expiresAt: new Date(),
        storageKey: '',
      }),
    ).rejects.toThrow(/storageKey/);

    await expect(
      model.complete(created.id, {
        artifactChecksum: 'sha256:x',
        // @ts-expect-error intentional
        expiresAt: null,
        storageKey: 'k',
      }),
    ).rejects.toThrow(/expiresAt/);
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
    const completed = await model.complete(c.id, {
      artifactChecksum: 'x',
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
});
