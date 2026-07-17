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
    await expect(
      journal.begin({ ...params, requestFingerprint: 'b'.repeat(64) }),
    ).resolves.toEqual({ status: 'reserved' });
    await journal.complete(acquired.token, {
      confirmation: null,
      content: 'done',
      success: true,
    });
    const replay = await journal.begin(params);
    expect(replay).toMatchObject({
      auditPending: true,
      result: { content: 'done', success: true },
      status: 'replay',
    });
    if (replay.status !== 'replay') throw new Error('journal did not replay');
    await journal.markAudited(replay.token);
    await expect(journal.begin(params)).resolves.toMatchObject({
      auditPending: false,
      status: 'replay',
    });
  });
});
