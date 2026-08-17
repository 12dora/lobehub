import { MessageGroupType } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { messageGroups, messages, sessions, threads, topics, users } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { MessageModel } from '../../message';

const userId = 'msg-role-content-user';
const otherUserId = 'msg-role-content-other';
const serverDB: LobeChatDatabase = await getTestDB();
const messageModel = new MessageModel(serverDB, userId);

describe('MessageModel.queryRoleContentByTopicIds', () => {
  beforeEach(async () => {
    await serverDB.delete(users);
    await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
    await serverDB.insert(sessions).values({ id: 'rcs-session', userId });
    await serverDB.insert(topics).values([
      { id: 'rcs-t1', sessionId: 'rcs-session', userId },
      { id: 'rcs-t2', sessionId: 'rcs-session', userId },
    ]);
  });

  afterEach(async () => {
    await serverDB.delete(users);
  });

  it('returns an empty map for an empty id list', async () => {
    expect(await messageModel.queryRoleContentByTopicIds([])).toEqual(new Map());
  });

  it('groups messages by topic in chronological order and skips other users / grouped rows', async () => {
    await serverDB.insert(messages).values([
      {
        content: 't1-old',
        createdAt: new Date('2024-01-01'),
        id: 'rcs-m1',
        role: 'user',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 't1-new',
        createdAt: new Date('2024-01-03'),
        id: 'rcs-m2',
        role: 'assistant',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 't2',
        createdAt: new Date('2024-01-02'),
        id: 'rcs-m3',
        role: 'user',
        topicId: 'rcs-t2',
        userId,
      },
      {
        content: 'hidden',
        createdAt: new Date('2024-01-04'),
        id: 'rcs-grouped',
        role: 'user',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 'stolen',
        id: 'rcs-other',
        role: 'user',
        topicId: 'rcs-t1',
        userId: otherUserId,
      },
    ]);
    await serverDB.insert(messageGroups).values({
      id: 'rcs-grp-1',
      topicId: 'rcs-t1',
      type: MessageGroupType.Compression,
      userId,
    });
    await serverDB
      .update(messages)
      .set({ messageGroupId: 'rcs-grp-1' })
      .where(eq(messages.id, 'rcs-grouped'));

    const map = await messageModel.queryRoleContentByTopicIds(['rcs-t1', 'rcs-t2', 'rcs-missing']);

    expect(map.get('rcs-t1')).toEqual([
      { content: 't1-old', role: 'user' },
      { content: 't1-new', role: 'assistant' },
    ]);
    expect(map.get('rcs-t2')).toEqual([{ content: 't2', role: 'user' }]);
    expect(map.has('rcs-missing')).toBe(false);
  });

  it('keeps only the last 5 user/assistant rows of a large topic, chronological', async () => {
    await serverDB.insert(messages).values(
      Array.from({ length: 50 }, (_, i) => ({
        content: `msg-${i}`,
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
        id: `rcs-large-${String(i).padStart(2, '0')}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        topicId: 'rcs-t1',
        userId,
      })),
    );

    const map = await messageModel.queryRoleContentByTopicIds(['rcs-t1']);
    const rows = map.get('rcs-t1') ?? [];

    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.content)).toEqual([
      'msg-45',
      'msg-46',
      'msg-47',
      'msg-48',
      'msg-49',
    ]);
  });

  it('excludes newer child-thread messages (legacy matchThread(undefined))', async () => {
    await serverDB.insert(messages).values([
      {
        content: 'root-old',
        createdAt: new Date('2024-01-01'),
        id: 'rcs-root-1',
        role: 'user',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 'root-new',
        createdAt: new Date('2024-01-02'),
        id: 'rcs-root-2',
        role: 'assistant',
        topicId: 'rcs-t1',
        userId,
      },
    ]);
    await serverDB.insert(threads).values({
      id: 'rcs-thread-1',
      sourceMessageId: 'rcs-root-1',
      topicId: 'rcs-t1',
      type: 'continuation',
      userId,
    });
    await serverDB.insert(messages).values([
      {
        content: 'thread-newer-1',
        createdAt: new Date('2024-01-10'),
        id: 'rcs-th-1',
        role: 'user',
        threadId: 'rcs-thread-1',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 'thread-newer-2',
        createdAt: new Date('2024-01-11'),
        id: 'rcs-th-2',
        role: 'assistant',
        threadId: 'rcs-thread-1',
        topicId: 'rcs-t1',
        userId,
      },
    ]);

    const map = await messageModel.queryRoleContentByTopicIds(['rcs-t1']);
    expect(map.get('rcs-t1')).toEqual([
      { content: 'root-old', role: 'user' },
      { content: 'root-new', role: 'assistant' },
    ]);
  });

  it('does not let whitespace-only newest rows consume the last-5 quota', async () => {
    await serverDB.insert(messages).values([
      {
        content: 'keep-1',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        id: 'rcs-ws-keep-1',
        role: 'user',
        topicId: 'rcs-t1',
        userId,
      },
      {
        content: 'keep-2',
        createdAt: new Date('2024-01-01T00:00:01Z'),
        id: 'rcs-ws-keep-2',
        role: 'assistant',
        topicId: 'rcs-t1',
        userId,
      },
      ...['   ', '\t', '\n', '\t\n  ', ' \r\n'].map((content, i) => ({
        content,
        createdAt: new Date(Date.UTC(2024, 0, 2, 0, 0, i)),
        id: `rcs-ws-blank-${i}`,
        role: 'user' as const,
        topicId: 'rcs-t1',
        userId,
      })),
    ]);

    const map = await messageModel.queryRoleContentByTopicIds(['rcs-t1']);
    expect(map.get('rcs-t1')).toEqual([
      { content: 'keep-1', role: 'user' },
      { content: 'keep-2', role: 'assistant' },
    ]);
  });

  it('does not let newer ECMAScript-whitespace-only rows consume the last-5 quota', async () => {
    // U+FEFF / U+00A0 / U+2028 pass POSIX `\S` but JS trim() treats them as empty.
    const ecmaws = ['\uFEFF', '\u00A0', '\u2028', '\uFEFF\u00A0', '\u00A0\u2028\uFEFF'];
    await serverDB.insert(messages).values([
      {
        content: 'keep-valid',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        id: 'rcs-ecma-keep',
        role: 'user',
        topicId: 'rcs-t1',
        userId,
      },
      ...ecmaws.map((content, i) => ({
        content,
        createdAt: new Date(Date.UTC(2024, 0, 2, 0, 0, i)),
        id: `rcs-ecma-blank-${i}`,
        role: 'user' as const,
        topicId: 'rcs-t1',
        userId,
      })),
    ]);

    const map = await messageModel.queryRoleContentByTopicIds(['rcs-t1']);
    expect(map.get('rcs-t1')).toEqual([{ content: 'keep-valid', role: 'user' }]);
  });
});
