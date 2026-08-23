/**
 * admin.audit router integration — permissions, aliases, reauth, self-audit.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditExports,
  platformAuditLegalHolds,
  platformAuditLogs,
  platformAuditPolicies,
  platformAuditRetentionRuns,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../../contracts/adminUsers';
import { createAdminAuthorizationFixture } from '../../testing/adminAuthorizationFixture';
import { adminRouter } from '../admin';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const createCaller = createCallerFactory(adminRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'admin-audit-a2' });

const staleReauthContext = (contexts: Awaited<ReturnType<typeof fixture.createContexts>>) => ({
  ...contexts.staleReauthSuper,
  authenticatedAt: new Date(Date.now() - ADMIN_REAUTH_MAX_AGE_MS - 1000),
});

const clearAuditLogs = async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeAll(async () => {
  db = await getTestDB();
}, 60_000);

beforeEach(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await clearAuditLogs();
  await fixture.setup(db);
  await clearAuditLogs();
  await db.delete(platformAuditLegalHolds);
  await db.delete(platformAuditExports);
  await db.delete(platformAuditRetentionRuns);
  await db.delete(platformJobs);
  await db.delete(platformAuditPolicies);
});

afterEach(async () => {
  await clearAuditLogs();
  await fixture.cleanup(db);
  await clearAuditLogs();
  await db.delete(platformAuditLegalHolds);
  await db.delete(platformAuditExports);
  await db.delete(platformAuditRetentionRuns);
  await db.delete(platformJobs);
  await db.delete(platformAuditPolicies);
  vi.unstubAllEnvs();
});

describe('admin.audit router', () => {
  it('allows auditor events.list / get aliases but denies conversation read', async () => {
    const contexts = await fixture.createContexts(db);
    const auditor = createCaller(contexts.auditor as never);
    const superAdmin = createCaller(contexts.superAdmin as never);

    await expect(auditor.audit.list({ targetType: '__none__' })).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    await expect(auditor.audit.events.list({ targetType: '__none__' })).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    await expect(auditor.audit.policy.get()).resolves.toMatchObject({
      contentAccessMode: 'metadata_only',
    });

    await expect(
      auditor.audit.conversations.list({ userId: fixture.actors.normal }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // users.timeline is conversation evidence — AUDIT_READ alone must not pass (F2).
    await expect(
      auditor.audit.users.timeline({ userId: fixture.actors.normal }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      superAdmin.audit.conversations.list({ userId: fixture.actors.normal }),
    ).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it('allows auditor operation_logs export but denies conversation export without conversation_read', async () => {
    const contexts = await fixture.createContexts(db);
    const auditor = createCaller(contexts.auditor as never);
    const superAdmin = createCaller(contexts.superAdmin as never);

    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const to = new Date();

    await expect(
      auditor.audit.exports.create({
        from,
        kind: 'operation_logs',
        reason: 'auditor op log export',
        to,
      }),
    ).resolves.toMatchObject({ kind: 'operation_logs', status: 'pending' });

    await expect(
      auditor.audit.exports.create({
        from,
        kind: 'conversations',
        reason: 'auditor conversation export denied',
        to,
        userId: fixture.actors.normal,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const superExport = await superAdmin.audit.exports.create({
      from,
      kind: 'conversations',
      reason: 'super conversation export',
      to,
      userId: fixture.actors.normal,
    });
    expect(superExport).toMatchObject({ kind: 'conversations', status: 'pending' });
    // Frozen non-secret policy caps are public on the projection
    expect(superExport.filterSnapshot).toMatchObject({
      maxExportRows: expect.any(Number),
      policyRevision: expect.any(Number),
      exportArtifactRetentionDays: expect.any(Number),
    });

    // Export-only auditor must not get/list conversation exports created by privileged actor
    await expect(auditor.audit.exports.get({ id: superExport.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await expect(auditor.audit.exports.list({ kind: 'conversations' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const auditorList = await auditor.audit.exports.list({ limit: 50 });
    expect(auditorList.items.every((i) => i.kind === 'operation_logs')).toBe(true);
    expect(auditorList.items.some((i) => i.id === superExport.id)).toBe(false);
  });

  it('requires reauth for exports.create and policy.update', async () => {
    const contexts = await fixture.createContexts(db);
    const stale = createCaller(staleReauthContext(contexts) as never);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date();

    await expect(
      stale.audit.exports.create({
        from,
        kind: 'operation_logs',
        reason: 'stale reauth export',
        to,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires reauth for policy.update and legalHolds.create', async () => {
    const contexts = await fixture.createContexts(db);
    const stale = createCaller(staleReauthContext(contexts) as never);
    const fresh = createCaller(contexts.superAdmin as never);

    await expect(
      stale.audit.policy.update({
        expectedRevision: 0,
        maxListWindowDays: 30,
        reason: 'tighten window',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const policy = await fresh.audit.policy.get();
    await expect(
      fresh.audit.policy.update({
        expectedRevision: policy.revision,
        maxListWindowDays: 45,
        reason: 'tighten window after reauth',
      }),
    ).resolves.toMatchObject({ maxListWindowDays: 45 });

    await expect(
      stale.audit.legalHolds.create({
        reason: 'litigation hold',
        scopeType: 'global',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await expect(
      fresh.audit.legalHolds.create({
        reason: 'litigation hold',
        scopeType: 'global',
      }),
    ).resolves.toMatchObject({ scopeType: 'global', status: 'active' });
  });

  it('records denied reauth without applying policy mutation', async () => {
    const contexts = await fixture.createContexts(db);
    const stale = createCaller(staleReauthContext(contexts) as never);
    const fresh = createCaller(contexts.superAdmin as never);

    const before = await fresh.audit.policy.get();

    await expect(
      stale.audit.policy.update({
        contentAccessMode: 'content_allowed',
        expectedRevision: before.revision,
        reason: 'should not apply',
      }),
    ).rejects.toBeTruthy();

    const after = await fresh.audit.policy.get();
    expect(after.revision).toBe(before.revision);
    expect(after.contentAccessMode).toBe(before.contentAccessMode);

    const denied = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.policy.update'));
    expect(denied.some((r) => r.result === 'denied')).toBe(true);
  });

  it('aliases list/get share event contracts with events.*', async () => {
    const contexts = await fixture.createContexts(db);
    await db.insert(platformAuditLogs).values({
      action: 'admin.users.ban',
      afterDiff: { banned: true, note: 'full-diff-kept' },
      id: 'alias-event-1',
      result: 'success',
      targetId: fixture.actors.normal,
      targetType: 'user',
    });

    const caller = createCaller(contexts.superAdmin as never);
    const viaAlias = await caller.audit.get({ id: 'alias-event-1' });
    const viaNested = await caller.audit.events.get({ id: 'alias-event-1' });
    expect(viaAlias.afterDiff).toEqual(viaNested.afterDiff);
    expect(viaAlias.afterDiff).toMatchObject({ note: 'full-diff-kept' });

    const listAlias = await caller.audit.list({ targetId: fixture.actors.normal });
    const listNested = await caller.audit.events.list({ targetId: fixture.actors.normal });
    expect(listAlias.items[0]).not.toHaveProperty('afterDiff');
    expect(listNested.items[0]).not.toHaveProperty('afterDiff');
  });

  it('denies auditor legal-hold manage', async () => {
    const contexts = await fixture.createContexts(db);
    const auditor = createCaller(contexts.auditor as never);
    await expect(auditor.audit.legalHolds.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows super_admin retention but denies auditor without AUDIT_RETENTION_OPERATE', async () => {
    const contexts = await fixture.createContexts(db);
    const auditor = createCaller(contexts.auditor as never);
    const superAdmin = createCaller(contexts.superAdmin as never);

    await expect(
      auditor.audit.retention.dryRun({ reason: 'auditor denied', scope: 'operation_logs' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(auditor.audit.retention.listRuns({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const dry = await superAdmin.audit.retention.dryRun({
      reason: 'super dry run',
      scope: 'operation_logs',
    });
    expect(dry.items).toHaveLength(1);
    expect(dry.items[0]).toMatchObject({ mode: 'dry_run', status: 'pending' });

    const got = await superAdmin.audit.retention.getRun({ id: dry.items[0]!.id });
    expect(got.id).toBe(dry.items[0]!.id);
    const status = await superAdmin.audit.retention.status({ id: dry.items[0]!.id });
    expect(status.id).toBe(dry.items[0]!.id);

    const listed = await superAdmin.audit.retention.listRuns({ limit: 10 });
    expect(listed.items.some((i) => i.id === dry.items[0]!.id)).toBe(true);
  });

  it('requires reauth for retention.dryRun / run / cancel', async () => {
    const contexts = await fixture.createContexts(db);
    const stale = createCaller(staleReauthContext(contexts) as never);
    const fresh = createCaller(contexts.superAdmin as never);

    await expect(
      stale.audit.retention.dryRun({ reason: 'stale reauth', scope: 'operation_logs' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      stale.audit.retention.run({ reason: 'stale reauth', scope: 'conversations' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const created = await fresh.audit.retention.run({
      reason: 'fresh reauth run',
      scope: 'export_artifacts',
    });
    await expect(
      stale.audit.retention.cancel({ id: created.items[0]!.id, reason: 'stale cancel' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
