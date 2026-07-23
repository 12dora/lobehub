// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditRetentionRuns } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditRetentionRunModel } from '../platform/auditRetentionRun';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditRetentionRunModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditRetentionRuns);
});

describe('PlatformAuditRetentionRunModel', () => {
  it('creates dry_run and execute runs with typed single scope, policyRevision, requestedBy', async () => {
    const cutoff = new Date('2025-01-01T00:00:00.000Z');
    const dry = await model.create({
      cutoffAt: cutoff,
      mode: 'dry_run',
      policyRevision: 0,
      requestedBy: 'admin-1',
      scope: 'operation_logs',
    });
    expect(dry.id).toMatch(/^parr_/);
    expect(dry.mode).toBe('dry_run');
    expect(dry.scope).toBe('operation_logs');
    expect(dry.status).toBe('pending');
    expect(dry.counts).toEqual({});
    expect(dry.policyRevision).toBe(0);
    expect(dry.requestedBy).toBe('admin-1');
    expect(dry.cutoffAt.toISOString()).toBe(cutoff.toISOString());

    const exec = await model.create({
      cutoffAt: cutoff,
      mode: 'execute',
      policyRevision: 1,
      requestedBy: 'admin-1',
      scope: 'conversations',
    });
    expect(exec.mode).toBe('execute');
    expect(exec.scope).toBe('conversations');
    expect(exec.policyRevision).toBe(1);
  });

  it('rejects stored scope "all" and requires requestedBy + policyRevision', async () => {
    await expect(
      model.create({
        cutoffAt: new Date(),
        mode: 'dry_run',
        policyRevision: 0,
        requestedBy: 'admin-1',
        // @ts-expect-error intentional — all is service fan-out only
        scope: 'all',
      }),
    ).rejects.toThrow(/not "all"/);

    await expect(
      model.create({
        cutoffAt: new Date(),
        mode: 'dry_run',
        policyRevision: 0,
        // Empty string is typed as string but rejected at runtime.
        requestedBy: '',
        scope: 'operation_logs',
      }),
    ).rejects.toThrow(/requestedBy is required/);

    await expect(
      model.create({
        cutoffAt: new Date(),
        mode: 'dry_run',
        // Negative revision is typed as number but rejected at runtime.
        policyRevision: -1,
        requestedBy: 'admin-1',
        scope: 'operation_logs',
      }),
    ).rejects.toThrow(/policyRevision/);
  });

  it('enforces unique jobId when set', async () => {
    await model.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      jobId: 'pjob_ret_1',
      mode: 'dry_run',
      policyRevision: 0,
      requestedBy: 'admin-1',
      scope: 'operation_logs',
    });
    await expect(
      model.create({
        cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
        jobId: 'pjob_ret_1',
        mode: 'execute',
        policyRevision: 1,
        requestedBy: 'admin-2',
        scope: 'export_artifacts',
      }),
    ).rejects.toThrow();
  });

  it('updates progress then completes with final counts', async () => {
    const run = await model.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      mode: 'execute',
      policyRevision: 2,
      requestedBy: 'admin-1',
      scope: 'conversations',
    });

    const progressing = await model.updateProgress(run.id, {
      counts: { conversationsScanned: 10, skippedLegalHold: 2 },
      markRunning: true,
      progressDone: 10,
      progressTotal: 100,
    });
    expect(progressing?.status).toBe('running');
    expect(progressing?.progressDone).toBe(10);
    expect(progressing?.progressTotal).toBe(100);
    expect(progressing?.counts).toMatchObject({ conversationsScanned: 10, skippedLegalHold: 2 });
    expect(progressing?.startedAt).toBeInstanceOf(Date);

    const completed = await model.complete(run.id, {
      counts: {
        conversationsDeleted: 8,
        conversationsScanned: 10,
        skippedLegalHold: 2,
      },
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.counts).toMatchObject({ conversationsDeleted: 8 });
    expect(completed?.finishedAt).toBeInstanceOf(Date);

    // terminal — further progress is a no-op
    await expect(model.updateProgress(run.id, { progressDone: 99 })).resolves.toBeUndefined();
  });

  it('fails and cancels open runs; ignores already-terminal rows', async () => {
    const run = await model.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      mode: 'dry_run',
      policyRevision: 0,
      requestedBy: 'admin-1',
      scope: 'export_artifacts',
    });
    const failed = await model.fail(run.id, { code: 'TIMEOUT', message: 'timed out' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatchObject({ code: 'TIMEOUT' });
    await expect(model.complete(run.id)).resolves.toBeUndefined();
    await expect(model.cancel(run.id)).resolves.toBeUndefined();

    const open = await model.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      mode: 'execute',
      policyRevision: 0,
      requestedBy: 'admin-1',
      scope: 'operation_logs',
    });
    const cancelled = await model.cancel(open.id);
    expect(cancelled?.status).toBe('cancelled');
    await expect(model.fail(open.id, { message: 'x' })).resolves.toBeUndefined();
  });

  it('lists with mode/scope/status filters and keyset pagination', async () => {
    const t0 = new Date('2026-07-01T00:00:00.000Z');
    await serverDB.insert(platformAuditRetentionRuns).values([
      {
        createdAt: t0,
        cutoffAt: t0,
        id: 'parr_0000000000000003',
        mode: 'execute',
        policyRevision: 1,
        requestedBy: 'admin-1',
        scope: 'conversations',
        status: 'completed',
      },
      {
        createdAt: t0,
        cutoffAt: t0,
        id: 'parr_0000000000000002',
        mode: 'dry_run',
        policyRevision: 0,
        requestedBy: 'admin-2',
        scope: 'operation_logs',
        status: 'running',
      },
      {
        createdAt: t0,
        cutoffAt: t0,
        id: 'parr_0000000000000001',
        mode: 'dry_run',
        policyRevision: 0,
        requestedBy: 'admin-1',
        scope: 'operation_logs',
        status: 'pending',
      },
    ]);

    const dryOnly = await model.list({ mode: 'dry_run' });
    expect(dryOnly.items.map((r) => r.id)).toEqual([
      'parr_0000000000000002',
      'parr_0000000000000001',
    ]);

    const admin1 = await model.list({ requestedBy: 'admin-1' });
    expect(admin1.items.every((r) => r.requestedBy === 'admin-1')).toBe(true);

    const page1 = await model.list({ limit: 1, scope: 'operation_logs' });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await model.list({
      cursor: page1.nextCursor!,
      limit: 10,
      scope: 'operation_logs',
    });
    expect(page2.items.map((r) => r.id)).toEqual(['parr_0000000000000001']);
  });

  it('get returns undefined for missing ids', async () => {
    await expect(model.get('parr_missing')).resolves.toBeUndefined();
  });

  it('setJobId links pending runs and is idempotent for same jobId', async () => {
    const run = await model.create({
      cutoffAt: new Date('2025-01-01T00:00:00.000Z'),
      mode: 'dry_run',
      policyRevision: 0,
      requestedBy: 'admin-1',
      scope: 'operation_logs',
    });
    const linked = await model.setJobId(run.id, 'pjob_ret_link');
    expect(linked?.jobId).toBe('pjob_ret_link');
    const again = await model.setJobId(run.id, 'pjob_ret_link');
    expect(again?.jobId).toBe('pjob_ret_link');
  });
});
