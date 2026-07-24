// @vitest-environment node
/**
 * Retention service contracts: create/list/cancel, fan-out, self-audit, lazy storage.
 * Sequential — shared real DB.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import {
  platformAuditLogs,
  platformAuditPolicies,
  platformAuditRetentionRuns,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AdminAuditRetentionService, PLATFORM_AUDIT_RETENTION_JOB_TYPE } from './index';

const serverDB: LobeChatDatabase = await getTestDB();
const actor = 'audit-retention-svc-actor';

const clearAuditLogs = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(async () => {
  await clearAuditLogs();
  await serverDB.delete(platformAuditRetentionRuns);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.insert(users).values([{ id: actor }]);
});

afterEach(async () => {
  await clearAuditLogs();
  await serverDB.delete(platformAuditRetentionRuns);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
});

describe('AdminAuditRetentionService', () => {
  it('constructs without storage and dryRun/list/get work without S3 env', async () => {
    expect(() => new AdminAuditRetentionService(serverDB)).not.toThrow();
    const service = new AdminAuditRetentionService(serverDB);

    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'dry without S3', scope: 'operation_logs' },
    });
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({
      mode: 'dry_run',
      scope: 'operation_logs',
      status: 'pending',
    });
    expect(created.items[0]!.jobId).toBeTruthy();

    const got = await service.getRun({ actorUserId: actor, id: created.items[0]!.id });
    expect(got.id).toBe(created.items[0]!.id);

    const status = await service.status({ actorUserId: actor, id: created.items[0]!.id });
    expect(status.id).toBe(created.items[0]!.id);

    const listed = await service.listRuns({
      actorUserId: actor,
      input: { limit: 10, mine: true },
    });
    expect(listed.items.some((i) => i.id === created.items[0]!.id)).toBe(true);
  });

  it('freezes cutoff from policy and policyRevision at create', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      conversationRetentionDays: 30,
      exportArtifactRetentionDays: 3,
      operationLogRetentionDays: 10,
      revision: 9,
    });

    const service = new AdminAuditRetentionService(serverDB);
    const before = Date.now();
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'freeze cutoffs', scope: 'operation_logs' },
    });
    const after = Date.now();
    const row = created.items[0]!;
    expect(row.policyRevision).toBe(9);
    const expectedCutoffMin = before - 10 * 24 * 60 * 60 * 1000;
    const expectedCutoffMax = after - 10 * 24 * 60 * 60 * 1000;
    expect(row.cutoffAt.getTime()).toBeGreaterThanOrEqual(expectedCutoffMin - 1000);
    expect(row.cutoffAt.getTime()).toBeLessThanOrEqual(expectedCutoffMax + 1000);

    const job = await serverDB.query.platformJobs.findFirst({
      where: eq(platformJobs.id, row.jobId!),
    });
    expect(job?.type).toBe(PLATFORM_AUDIT_RETENTION_JOB_TYPE);
    expect(job?.input).toMatchObject({ runId: row.id });
    expect(job?.maxAttempts).toBe(3);
  });

  it('fans out scope=all into three single-scope rows with jobs', async () => {
    const service = new AdminAuditRetentionService(serverDB);
    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'fanout all', scope: 'all' },
    });
    expect(created.items).toHaveLength(3);
    expect(created.items.map((i) => i.scope).sort()).toEqual([
      'conversations',
      'export_artifacts',
      'operation_logs',
    ]);
    expect(created.items.every((i) => i.mode === 'dry_run')).toBe(true);
    expect(created.items.every((i) => i.jobId)).toBe(true);
    // Never persist scope=all
    expect(created.items.every((i) => i.scope !== ('all' as string))).toBe(true);

    const jobs = await serverDB.select().from(platformJobs);
    expect(jobs.filter((j) => j.type === PLATFORM_AUDIT_RETENTION_JOB_TYPE)).toHaveLength(3);
  });

  it('cancels open run and linked job; self-audits success', async () => {
    const service = new AdminAuditRetentionService(serverDB);
    const created = await service.run({
      actorUserId: actor,
      input: { reason: 'to cancel', scope: 'conversations' },
    });
    const id = created.items[0]!.id;
    const jobId = created.items[0]!.jobId!;

    const cancelled = await service.cancel({
      actorUserId: actor,
      input: { id, reason: 'operator cancel' },
    });
    expect(cancelled.status).toBe('cancelled');

    const job = await serverDB.query.platformJobs.findFirst({ where: eq(platformJobs.id, jobId) });
    expect(job?.status).toBe('cancelled');

    const logs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.retention.cancel'));
    expect(logs.some((l) => l.result === 'success' && l.targetId === id)).toBe(true);
  });

  it('self-audits dryRun and run success without free text secrets', async () => {
    const service = new AdminAuditRetentionService(serverDB);
    await service.dryRun({
      actorUserId: actor,
      input: { reason: 'audit trail dry', scope: 'export_artifacts' },
    });
    await service.run({
      actorUserId: actor,
      input: { reason: 'audit trail run', scope: 'export_artifacts' },
    });

    const dryLogs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.retention.dryRun'));
    expect(dryLogs.some((l) => l.result === 'success')).toBe(true);
    // No body-like free text fields beyond reason
    for (const log of dryLogs) {
      expect(log.afterDiff).not.toHaveProperty('body');
      expect(log.afterDiff).not.toHaveProperty('q');
      expect(JSON.stringify(log.afterDiff ?? {})).not.toMatch(/secret|password|token/i);
    }

    const runLogs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.retention.run'));
    expect(runLogs.some((l) => l.result === 'success')).toBe(true);
  });

  it('rejects cancel of terminal run', async () => {
    const service = new AdminAuditRetentionService(serverDB);
    const created = await service.dryRun({
      actorUserId: actor,
      input: { reason: 'terminal cancel', scope: 'operation_logs' },
    });
    await service.cancel({
      actorUserId: actor,
      input: { id: created.items[0]!.id, reason: 'first cancel' },
    });
    await expect(
      service.cancel({
        actorUserId: actor,
        input: { id: created.items[0]!.id, reason: 'second cancel' },
      }),
    ).rejects.toBeTruthy();
  });

  it('createFanout rolls back all scopes when partial fan-out fails inside the publication TX', async () => {
    const service = new AdminAuditRetentionService(serverDB, {
      afterCreateRun: async ({ index }) => {
        if (index === 1) {
          throw new Error('INJECTED_FANOUT_FAILURE');
        }
      },
    });

    await expect(
      service.dryRun({
        actorUserId: actor,
        input: { reason: 'partial fanout', scope: 'all' },
      }),
    ).rejects.toThrow(/INJECTED_FANOUT_FAILURE/);

    // Atomic fan-out: no claimable run or job survives a mid-create failure (F1).
    const runs = await serverDB.select().from(platformAuditRetentionRuns);
    expect(runs).toHaveLength(0);

    const jobs = await serverDB
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.type, PLATFORM_AUDIT_RETENTION_JOB_TYPE));
    expect(jobs).toHaveLength(0);
  });
});
