// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformJobs } from '@/database/schemas/platform';

import {
  __resetConnectorRuntimeAuditWorkerForTests,
  ensureConnectorRuntimeAuditWorkerStarted,
  isConnectorRuntimeAuditReconcilerConfigured,
  runConnectorRuntimeAuditBatch,
} from './runtimeAuditWorker';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const db = await getTestDB();
const jobIds: string[] = [];
const auditIds: string[] = [];

afterEach(async () => {
  __resetConnectorRuntimeAuditWorkerForTests();
  vi.unstubAllEnvs();
  // Migration 0145: audit logs are append-only; tests use the session GUC escape hatch.
  if (auditIds.length > 0) {
    const ids = auditIds.splice(0);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
      await tx.delete(platformAuditLogs).where(inArray(platformAuditLogs.id, ids));
    });
  }
  if (jobIds.length > 0) {
    const ids = jobIds.splice(0);
    await db.delete(platformJobs).where(inArray(platformJobs.id, ids));
  }
});

describe('connector runtime audit worker', () => {
  it('claims a completed outbox row and converges it to one allowed audit', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-worker',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'd'.repeat(64),
      toolCallId: 'tool-call-worker',
      toolKey: 'search',
      userId: 'user-worker',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    jobIds.push(acquired.token.jobId);
    auditIds.push(`connector-runtime-audit:${acquired.token.jobId}`);
    await journal.arm(acquired.token);
    await journal.complete(acquired.token, {
      confirmation: null,
      content: 'done',
      success: true,
    });

    await expect(runConnectorRuntimeAuditBatch(db)).resolves.toBe(1);
    await expect(runConnectorRuntimeAuditBatch(db)).resolves.toBe(0);
    await expect(
      db.query.platformAuditLogs.findFirst({
        where: eq(platformAuditLogs.id, `connector-runtime-audit:${acquired.token.jobId}`),
      }),
    ).resolves.toMatchObject({
      action: 'connector.runtime.sharedCall',
      afterDiff: expect.objectContaining({ outcome: 'allowed' }),
    });
    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('serverless batch entrypoint converges pending completed audits without a poller', async () => {
    // Vercel skips the persistent poller; the cron/batch path must still converge.
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    ensureConnectorRuntimeAuditWorkerStarted();

    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-vercel-pending',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'e'.repeat(64),
      toolCallId: 'tool-call-vercel-pending',
      toolKey: 'search',
      userId: 'user-vercel',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    jobIds.push(acquired.token.jobId);
    auditIds.push(`connector-runtime-audit:${acquired.token.jobId}`);
    await journal.arm(acquired.token);
    await journal.complete(acquired.token, {
      confirmation: null,
      content: 'vercel-pending',
      success: true,
    });

    await expect(runConnectorRuntimeAuditBatch(db)).resolves.toBe(1);
    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('serverless batch entrypoint converges expired ambiguous running rows as unknown', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-vercel-expired',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'f'.repeat(64),
      toolCallId: 'tool-call-vercel-expired',
      toolKey: 'search',
      userId: 'user-vercel',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    jobIds.push(acquired.token.jobId);
    auditIds.push(`connector-runtime-audit:${acquired.token.jobId}`);
    await journal.arm(acquired.token);
    // Expire the running lease so reconcileNext treats the outcome as unknown.
    await db
      .update(platformJobs)
      .set({ leaseUntil: new Date(Date.now() - 60_000) })
      .where(eq(platformJobs.id, acquired.token.jobId));

    await expect(runConnectorRuntimeAuditBatch(db)).resolves.toBe(1);
    await expect(
      db.query.platformAuditLogs.findFirst({
        where: eq(platformAuditLogs.id, `connector-runtime-audit:${acquired.token.jobId}`),
      }),
    ).resolves.toMatchObject({
      action: 'connector.runtime.sharedCall',
      afterDiff: expect.objectContaining({ outcome: 'unknown' }),
    });
  });

  it('reports reconciler availability for persistent, serverless opt-in, and bare Vercel', () => {
    expect(
      isConnectorRuntimeAuditReconcilerConfigured({
        DATABASE_URL: 'postgres://local',
        NODE_ENV: 'production',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).toBe(true);
    expect(
      isConnectorRuntimeAuditReconcilerConfigured({
        CONNECTOR_RUNTIME_AUDIT_RECONCILE_ENABLED: '1',
        VERCEL_ENV: 'production',
      }),
    ).toBe(true);
    expect(
      isConnectorRuntimeAuditReconcilerConfigured({
        VERCEL_ENV: 'production',
      }),
    ).toBe(false);
    // Non-serverless local/dev remains available (in-request delivery is primary).
    expect(isConnectorRuntimeAuditReconcilerConfigured({})).toBe(true);
  });
});
