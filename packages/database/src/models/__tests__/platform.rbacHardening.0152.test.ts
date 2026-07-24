// @vitest-environment node
/**
 * Migration 0152_round2_rbac_hardening — GUC-trust immutability defense-in-depth.
 *
 * The migration is a SAFE, DOUBLE-GATED NO-OP SCAFFOLD: it installs NO app-callable
 * SECURITY DEFINER bypass, and its only privilege statement (REVOKE DELETE from a
 * dedicated non-superuser role) runs ONLY when BOTH (a) the explicit activation
 * marker aihub.rbac_hardening_activate='on' AND (b) a dedicated non-superuser role
 * exist. On PGlite / superuser / demo (neither holds) it is a complete no-op.
 *
 * PGlite (default) verifies: real migration applies twice as a no-op, NO purge
 * functions exist (removed as an arbitrary-delete risk), zero privilege change, the
 * existing retention GUC direct-DELETE path keeps working, and the append-only
 * trigger still rejects an unguarded DELETE. Role-activation behaviour is covered by
 * the gated *.pg.test.ts (real Postgres).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditLogs } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditRetentionRepository } from '../platform/auditRetention';

const migrationsDir = path.join(__dirname, '../../../migrations');
const migrationSql = readFileSync(
  path.join(migrationsDir, '0152_round2_rbac_hardening.sql'),
  'utf8',
);

const applySql = async (db: LobeChatDatabase, sqlText: string) => {
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await db.execute(sql.raw(trimmed));
  }
};

const unwrap = <T extends Record<string, unknown>>(result: unknown): T | undefined => {
  if (Array.isArray(result)) return result[0] as T | undefined;
  return (result as { rows?: T[] }).rows?.[0];
};

const serverDB: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await serverDB.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
  await serverDB.execute(sql.raw('TRUNCATE TABLE platform_audit_legal_holds CASCADE'));
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

describe('0152_round2_rbac_hardening (PGlite / default — no activation, no dedicated role)', () => {
  it('applies the real migration twice as a clean no-op (idempotent)', async () => {
    // No dedicated candidate roles and no activation marker exist in the test DB.
    const rolesBefore = await serverDB.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM pg_roles
      WHERE rolname IN ('aihub_app', 'lobe_app')
    `);
    expect(Number(unwrap<{ n: string }>(rolesBefore)?.n ?? '0')).toBe(0);

    await applySql(serverDB, migrationSql);
    await applySql(serverDB, migrationSql);

    // NO app-callable SECURITY DEFINER bypass exists (removed as arbitrary-delete risk).
    const fns = await serverDB.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'platform_purge_audit_logs',
          'platform_purge_agent_versions_for_agent',
          'platform_purge_agent_versions'
        )
    `);
    expect(Number(unwrap<{ n: string }>(fns)?.n ?? '0')).toBe(0);

    // Zero privilege change: connected (super) role retains DELETE on the guarded table.
    const priv = await serverDB.execute<{ owner_delete: boolean }>(sql`
      SELECT has_table_privilege(current_user, 'platform_audit_logs', 'DELETE') AS owner_delete
    `);
    expect(unwrap<{ owner_delete: boolean }>(priv)?.owner_delete).toBe(true);
  });

  it('keeps the existing retention GUC direct-DELETE path working (no REVOKE applied)', async () => {
    await applySql(serverDB, migrationSql);

    await serverDB.insert(platformAuditLogs).values({
      action: 'test.retention.guc',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      id: 'audit-ret-guc-ok',
      result: 'success',
      targetType: 'settings',
    });

    const repo = new PlatformAuditRetentionRepository(serverDB);
    const deleted = await repo.deleteOperationLogsRechecked({
      cutoffAt: new Date('2021-01-01T00:00:00.000Z'),
      ids: ['audit-ret-guc-ok'],
    });
    expect(deleted).toBe(1);
  });

  it('still rejects an unguarded audit DELETE (append-only trigger intact; no bypass function)', async () => {
    await applySql(serverDB, migrationSql);

    await serverDB.insert(platformAuditLogs).values({
      action: 'test.no-auth',
      id: 'audit-no-auth',
      result: 'success',
      targetType: 'settings',
    });

    await expectRejectedWith(
      serverDB.delete(platformAuditLogs).where(eq(platformAuditLogs.id, 'audit-no-auth')),
      /append-only/i,
    );

    const still = await serverDB
      .select({ id: platformAuditLogs.id })
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.id, 'audit-no-auth'));
    expect(still).toHaveLength(1);
  });
});
