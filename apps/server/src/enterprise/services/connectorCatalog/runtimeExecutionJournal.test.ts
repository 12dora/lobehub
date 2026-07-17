// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformJobs } from '@/database/schemas/platform';

import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const db = await getTestDB();
const createdIds: string[] = [];

afterEach(async () => {
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
});
