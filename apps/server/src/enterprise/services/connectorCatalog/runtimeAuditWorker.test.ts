// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformJobs } from '@/database/schemas/platform';

import { runConnectorRuntimeAuditBatch } from './runtimeAuditWorker';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const db = await getTestDB();
const jobIds: string[] = [];
const auditIds: string[] = [];

afterEach(async () => {
  for (const id of auditIds.splice(0))
    await db.delete(platformAuditLogs).where(eq(platformAuditLogs.id, id));
  for (const id of jobIds.splice(0)) await db.delete(platformJobs).where(eq(platformJobs.id, id));
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
});
