// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { topics, users } from '@/database/schemas';

import { TopicService } from './topic.service';
import { UserService } from './user.service';

interface PermissionBypass {
  resolveOperationPermission: () => Promise<{
    condition?: { userId?: string };
    isPermitted: boolean;
  }>;
}

const db = await getTestDB();
const userId = 'openapi-public-user';
const topicId = 'openapi-public-topic';

const allowOperations = (service: object) =>
  vi
    .spyOn(service as PermissionBypass, 'resolveOperationPermission')
    .mockResolvedValue({ isPermitted: true });

const expectNoDingTalkClaims = (value: unknown) => {
  expect(JSON.stringify(value)).not.toMatch(/dingtalkTitle|dingtalkUserId/);
};

describe('OpenAPI public user projection', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await db.delete(users);
    await db.insert(users).values({
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
      email: 'ada@example.test',
      fullName: 'Ada Lovelace',
      id: userId,
    });
    await db.insert(topics).values({ id: topicId, title: 'Private identity boundary', userId });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(users);
  });

  it('removes trusted claims from current-user and user-list responses', async () => {
    const service = new UserService(db, userId);
    allowOperations(service);

    const currentUser = await service.getCurrentUser(false);
    const userList = await service.queryUsers({});

    expect(currentUser.id).toBe(userId);
    expect(userList.users).toHaveLength(1);
    expectNoDingTalkClaims(currentUser);
    expectNoDingTalkClaims(userList);
  });

  it('removes trusted claims from topic list and detail responses', async () => {
    const service = new TopicService(db, userId);
    allowOperations(service);

    const topicList = await service.getTopics({});
    const topicDetail = await service.getTopicById(topicId);

    expect(topicList.topics).toHaveLength(1);
    expect(topicDetail.id).toBe(topicId);
    expectNoDingTalkClaims(topicList);
    expectNoDingTalkClaims(topicDetail);
  });
});
