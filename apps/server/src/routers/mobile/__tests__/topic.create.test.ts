// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { sessions, topics, userSettings } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupTestUser,
  createTestContext,
  createTestUser,
} from '../../lambda/__tests__/integration/setup';
import { topicRouter } from '../topic';

let testDB: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(() => testDB),
}));

describe('mobile topicRouter.createTopic', () => {
  let serverDB: LobeChatDatabase;
  let userId: string;
  let testSessionId: string;

  beforeEach(async () => {
    serverDB = await getTestDB();
    testDB = serverDB;
    userId = await createTestUser(serverDB);
    const [session] = await serverDB.insert(sessions).values({ userId, type: 'agent' }).returning();
    testSessionId = session.id;
  });

  afterEach(async () => {
    await cleanupTestUser(serverDB, userId);
  });

  it('accepts metadata.approvalMode from a mobile client', async () => {
    const caller = topicRouter.createCaller(createTestContext(userId));

    const topicId = await caller.createTopic({
      metadata: { approvalMode: 'allow-list' },
      sessionId: testSessionId,
      title: 'Mobile snapshot',
    });

    const [createdTopic] = await serverDB.select().from(topics).where(eq(topics.id, topicId));
    expect(createdTopic.metadata).toEqual({ approvalMode: 'allow-list' });
  });

  it('snapshots built-in manual for a legacy mobile client that omits approvalMode', async () => {
    const caller = topicRouter.createCaller(createTestContext(userId));

    const topicId = await caller.createTopic({
      sessionId: testSessionId,
      title: 'Legacy mobile',
    });

    const [createdTopic] = await serverDB.select().from(topics).where(eq(topics.id, topicId));
    expect(createdTopic.metadata).toEqual({ approvalMode: 'manual' });
  });

  it('snapshots the stored user preference when the mobile client omits approvalMode', async () => {
    await serverDB.insert(userSettings).values({
      id: userId,
      tool: { humanIntervention: { approvalMode: 'auto-run' } },
    });

    const caller = topicRouter.createCaller(createTestContext(userId));
    const topicId = await caller.createTopic({
      sessionId: testSessionId,
      title: 'Pref mobile',
    });

    const [createdTopic] = await serverDB.select().from(topics).where(eq(topics.id, topicId));
    expect(createdTopic.metadata).toEqual({ approvalMode: 'auto-run' });
  });
});
