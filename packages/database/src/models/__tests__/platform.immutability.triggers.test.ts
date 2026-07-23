// @vitest-environment node
/**
 * Real-Postgres/PGlite enforcement of migration 0145 immutability triggers.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditLogs, platformResourceRevisions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditRetentionRepository } from '../platform/auditRetention';

const serverDB: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await serverDB.execute(
    sql.raw('TRUNCATE TABLE platform_audit_logs, platform_resource_revisions CASCADE'),
  );
};

/** Drizzle wraps PG errors; match message or cause. */
const expectRejectedWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (error) {
    const err = error as Error & { cause?: Error };
    const text = `${err.message}\n${err.cause?.message ?? ''}`;
    expect(text).toMatch(pattern);
  }
};

beforeEach(cleanup);
afterEach(cleanup);

describe('platform revision / audit immutability triggers (0145)', () => {
  it('rejects UPDATE and DELETE on platform_resource_revisions', async () => {
    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'a'.repeat(64),
      id: 'rev-immut-1',
      payload: { ok: true },
      resourceId: 'global',
      resourceType: 'settings',
      revision: 1,
      status: 'published',
    });

    await expectRejectedWith(
      serverDB
        .update(platformResourceRevisions)
        .set({ payload: { tampered: true } })
        .where(eq(platformResourceRevisions.id, 'rev-immut-1')),
      /immutable/i,
    );

    await expectRejectedWith(
      serverDB
        .delete(platformResourceRevisions)
        .where(eq(platformResourceRevisions.id, 'rev-immut-1')),
      /immutable/i,
    );

    const still = await serverDB
      .select({ id: platformResourceRevisions.id })
      .from(platformResourceRevisions);
    expect(still).toHaveLength(1);
  });

  it('rejects UPDATE and unauthorized DELETE on platform_audit_logs', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'test.action',
      id: 'audit-immut-1',
      result: 'success',
      targetType: 'settings',
    });

    await expectRejectedWith(
      serverDB
        .update(platformAuditLogs)
        .set({ result: 'failure' })
        .where(eq(platformAuditLogs.id, 'audit-immut-1')),
      /append-only/i,
    );

    await expectRejectedWith(
      serverDB.delete(platformAuditLogs).where(eq(platformAuditLogs.id, 'audit-immut-1')),
      /append-only/i,
    );

    const still = await serverDB.select({ id: platformAuditLogs.id }).from(platformAuditLogs);
    expect(still).toHaveLength(1);
  });

  it('allows retention-authorized audit DELETE via transaction-local GUC', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z');
    await serverDB.insert(platformAuditLogs).values({
      action: 'test.retention',
      createdAt: old,
      id: 'audit-ret-ok',
      result: 'success',
      targetType: 'settings',
    });

    const repo = new PlatformAuditRetentionRepository(serverDB);
    const deleted = await repo.deleteOperationLogsRechecked({
      cutoffAt: new Date('2021-01-01T00:00:00.000Z'),
      ids: ['audit-ret-ok'],
    });
    expect(deleted).toBe(1);

    const remaining = await serverDB
      .select({ id: platformAuditLogs.id })
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'audit-ret-ok'));
    expect(remaining).toHaveLength(0);
  });

  it('rejects audit DELETE when GUC is not set even inside a transaction', async () => {
    await serverDB.insert(platformAuditLogs).values({
      action: 'test.no-guc',
      id: 'audit-no-guc',
      result: 'success',
      targetType: 'settings',
    });

    await expectRejectedWith(
      serverDB.transaction(async (tx) => {
        await tx.delete(platformAuditLogs).where(eq(platformAuditLogs.id, 'audit-no-guc'));
      }),
      /append-only/i,
    );
  });
});
