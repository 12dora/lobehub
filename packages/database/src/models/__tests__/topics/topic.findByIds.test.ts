import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { sessions, topics, users, workspaces } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { TopicModel } from '../../topic';

const userId = 'topic-findbyids-user';
const otherUserId = 'topic-findbyids-other';
const sessionId = 'topic-findbyids-session';

const serverDB: LobeChatDatabase = await getTestDB();
const topicModel = new TopicModel(serverDB, userId);

describe('TopicModel.findByIds', () => {
  beforeEach(async () => {
    await serverDB.delete(users);
    await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
    await serverDB.insert(sessions).values({ id: sessionId, userId });
  });

  afterEach(async () => {
    await serverDB.delete(users);
  });

  it('returns an empty map for an empty id list', async () => {
    expect(await topicModel.findByIds([])).toEqual(new Map());
  });

  it('returns owned topics keyed by id and omits missing / other-user ids', async () => {
    await serverDB.insert(topics).values([
      { historySummary: 'sum-a', id: 't-own-a', sessionId, title: 'A', userId },
      { id: 't-own-b', sessionId, title: 'B', userId },
      { id: 't-other', title: 'Nope', userId: otherUserId },
    ]);

    const map = await topicModel.findByIds(['t-own-a', 't-missing', 't-other', 't-own-b']);

    expect([...map.keys()].sort()).toEqual(['t-own-a', 't-own-b']);
    expect(map.get('t-own-a')?.historySummary).toBe('sum-a');
    expect(map.get('t-own-a')?.title).toBe('A');
    expect(map.has('t-missing')).toBe(false);
    expect(map.has('t-other')).toBe(false);
  });

  it('respects workspace ownership', async () => {
    await serverDB.insert(workspaces).values({
      id: 'topic-findbyids-ws',
      name: 'WS',
      primaryOwnerId: userId,
      slug: 'topic-findbyids-ws',
    });
    await serverDB.insert(sessions).values({
      id: 'topic-findbyids-ws-session',
      userId,
      workspaceId: 'topic-findbyids-ws',
    });
    await serverDB.insert(topics).values([
      { id: 't-personal', sessionId, title: 'personal', userId, workspaceId: null },
      {
        id: 't-ws',
        sessionId: 'topic-findbyids-ws-session',
        title: 'workspace',
        userId,
        workspaceId: 'topic-findbyids-ws',
      },
    ]);

    const personal = await topicModel.findByIds(['t-personal', 't-ws']);
    const workspace = await new TopicModel(serverDB, userId, 'topic-findbyids-ws').findByIds([
      't-personal',
      't-ws',
    ]);

    expect([...personal.keys()]).toEqual(['t-personal']);
    expect([...workspace.keys()]).toEqual(['t-ws']);
  });
});
