// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformJobs } from '@/database/schemas/platform';

import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const db = await getTestDB();
const createdIds: string[] = [];
const runPostgres = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

afterEach(async () => {
  vi.useRealTimers();
  for (const id of createdIds.splice(0)) {
    await db.delete(platformJobs).where(eq(platformJobs.id, id));
  }
});

describe('DatabaseConnectorRuntimeExecutionJournal', () => {
  it('reserves once and replays the terminal result without redispatch', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const params = {
      connectorId: 'connector-1',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'a'.repeat(64),
      toolCallId: 'tool-call-1',
      toolKey: 'search',
      userId: 'user-1',
    };
    const acquired = await journal.begin(params);
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    createdIds.push(acquired.token.jobId);

    await expect(journal.begin(params)).resolves.toEqual({ status: 'reserved' });
    await expect(journal.begin({ ...params, requestFingerprint: 'b'.repeat(64) })).resolves.toEqual(
      { status: 'reserved' },
    );
    await journal.arm(acquired.token);
    await journal.complete(acquired.token, {
      confirmation: null,
      content: 'done',
      success: true,
    });
    const pendingReplay = await journal.begin(params);
    expect(pendingReplay).toMatchObject({
      auditPending: true,
      result: { content: 'done', success: true },
      status: 'replay',
    });
    if (pendingReplay.status !== 'replay') throw new Error('journal did not replay');
    const delivered: string[] = [];
    const results = await Promise.all([
      journal.deliverAudit(pendingReplay.token, async (record) => {
        delivered.push(record.outcome);
      }),
      journal.deliverAudit(pendingReplay.token, async (record) => {
        delivered.push(record.outcome);
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(delivered).toEqual(['allowed']);
    await expect(journal.begin(params)).resolves.toMatchObject({
      auditPending: false,
      status: 'replay',
    });
  });

  it('reconciles an expired ambiguous call as unknown without redispatch', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-unknown',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'c'.repeat(64),
      toolCallId: 'tool-call-unknown',
      toolKey: 'write',
      userId: 'user-unknown',
    });
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    createdIds.push(acquired.token.jobId);
    await journal.arm(acquired.token);
    await db
      .update(platformJobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(platformJobs.id, acquired.token.jobId));
    const delivered: string[] = [];

    await expect(
      journal.reconcileNext(async (record) => {
        delivered.push(record.outcome);
      }),
    ).resolves.toBe(true);

    expect(delivered).toEqual(['unknown']);
    await expect(
      db.query.platformJobs.findFirst({
        where: eq(platformJobs.id, acquired.token.jobId),
      }),
    ).resolves.toMatchObject({ status: 'dead' });
  });

  it('cleans an expired unarmed reservation without producing an unknown audit', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-reserved',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'e'.repeat(64),
      toolCallId: 'tool-call-reserved',
      toolKey: 'write',
      userId: 'user-reserved',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    await db
      .update(platformJobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(platformJobs.id, acquired.token.jobId));
    const delivered: string[] = [];

    await expect(
      journal.reconcileNext(async (record) => {
        delivered.push(record.outcome);
      }),
    ).resolves.toBe(true);
    expect(delivered).toEqual([]);
    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toBeUndefined();
  });

  it('renews a live reservation from the arm instant', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-arm-renew',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: 'f'.repeat(64),
      toolCallId: 'tool-call-arm-renew',
      toolKey: 'write',
      userId: 'user-arm-renew',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    createdIds.push(acquired.token.jobId);
    const beforeArm = new Date();

    await journal.arm(acquired.token);

    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toMatchObject({
      heartbeatAt: expect.any(Date),
      leaseUntil: expect.any(Date),
      startedAt: expect.any(Date),
      status: 'running',
    });
    const armed = await db.query.platformJobs.findFirst({
      where: eq(platformJobs.id, acquired.token.jobId),
    });
    expect(armed!.leaseUntil!.getTime()).toBeGreaterThan(beforeArm.getTime() + 29_000);
    expect(armed!.startedAt!.getTime()).toBeGreaterThanOrEqual(beforeArm.getTime());
  });

  it('lets cleanup win at the expiry boundary and never arms or audits the reservation', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-arm-expired',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: '1'.repeat(64),
      toolCallId: 'tool-call-arm-expired',
      toolKey: 'write',
      userId: 'user-arm-expired',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    await db
      .update(platformJobs)
      .set({ leaseUntil: new Date(0) })
      .where(eq(platformJobs.id, acquired.token.jobId));
    const delivered: string[] = [];

    const [armResult, cleanupResult] = await Promise.allSettled([
      journal.arm(acquired.token),
      journal.reconcileNext(async (record) => {
        delivered.push(record.outcome);
      }),
    ]);
    expect(armResult.status).toBe('rejected');
    expect(cleanupResult).toMatchObject({ status: 'fulfilled', value: true });
    expect(delivered).toEqual([]);
    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toBeUndefined();
  });

  it.runIf(runPostgres)(
    'uses the database clock for reservation creation, cleanup, and arm under clock skew',
    async () => {
      const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));
      const acquired = await journal.begin({
        connectorId: 'connector-clock-skew',
        operationId: `operation-${crypto.randomUUID()}`,
        requestFingerprint: '2'.repeat(64),
        toolCallId: 'tool-call-clock-skew',
        toolKey: 'write',
        userId: 'user-clock-skew',
      });
      if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
      createdIds.push(acquired.token.jobId);
      vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));

      await expect(journal.reconcileNext(async () => {})).resolves.toBe(false);
      await expect(journal.arm(acquired.token)).resolves.toBeUndefined();

      const [databaseClock] = await db.select({ now: sql<Date>`statement_timestamp()` });
      const armed = await db.query.platformJobs.findFirst({
        where: eq(platformJobs.id, acquired.token.jobId),
      });
      expect(armed).toMatchObject({
        heartbeatAt: expect.any(Date),
        leaseUntil: expect.any(Date),
        startedAt: expect.any(Date),
        status: 'running',
      });
      expect(Math.abs(armed!.heartbeatAt!.getTime() - databaseClock.now.getTime())).toBeLessThan(
        5000,
      );
      expect(armed!.leaseUntil!.getTime() - armed!.heartbeatAt!.getTime()).toBe(30_000);
    },
  );

  it('reports audit delivery CAS loss and does not redeliver the claimed row', async () => {
    const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
    const acquired = await journal.begin({
      connectorId: 'connector-delivery-cas',
      operationId: `operation-${crypto.randomUUID()}`,
      requestFingerprint: '3'.repeat(64),
      toolCallId: 'tool-call-delivery-cas',
      toolKey: 'write',
      userId: 'user-delivery-cas',
    });
    if (acquired.status !== 'acquired') throw new Error('journal was not acquired');
    createdIds.push(acquired.token.jobId);
    await journal.arm(acquired.token);
    await journal.complete(acquired.token, {
      confirmation: null,
      content: 'done',
      success: true,
    });
    const delivery = vi.fn(async () => {
      await db
        .update(platformJobs)
        .set({ leaseOwner: null, leaseUntil: null, status: 'cancelled' })
        .where(eq(platformJobs.id, acquired.token.jobId));
    });

    await expect(journal.deliverAudit(acquired.token, delivery)).resolves.toBe(false);
    await expect(journal.deliverAudit(acquired.token, delivery)).resolves.toBe(false);
    expect(delivery).toHaveBeenCalledTimes(1);
    await expect(
      db.query.platformJobs.findFirst({ where: eq(platformJobs.id, acquired.token.jobId) }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });
});
