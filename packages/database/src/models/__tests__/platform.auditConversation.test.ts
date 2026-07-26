// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { messages, topics, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import {
  isCredentialKey,
  maskCredentialsDeep,
  maskCredentialsInText,
  PlatformAuditConversationModel,
} from '../platform';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditConversationModel(serverDB);

const userA = 'audit-conv-user-a';
const userB = 'audit-conv-user-b';

beforeEach(async () => {
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(users).where(eq(users.id, userA));
  await serverDB.delete(users).where(eq(users.id, userB));
  await serverDB.insert(users).values([{ id: userA }, { id: userB }]);
});

afterEach(async () => {
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(users).where(eq(users.id, userA));
  await serverDB.delete(users).where(eq(users.id, userB));
});

describe('PlatformAuditConversationModel', () => {
  it('requires userId for topic list and does not leak other users topics', async () => {
    await expect(model.listTopics({ userId: '' })).rejects.toThrow(/userId is required/i);

    const [topicA] = await serverDB
      .insert(topics)
      .values({ id: 'topic-a', title: 'Alpha secrets plan', userId: userA })
      .returning();
    await serverDB
      .insert(topics)
      .values({ id: 'topic-b', title: 'Beta secrets plan', userId: userB });

    const page = await model.listTopics({ limit: 50, userId: userA });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(topicA.id);
    expect(page.items.every((t) => t.userId === userA)).toBe(true);
  });

  it('requires userId+topicId for messages and isolates by both', async () => {
    await serverDB.insert(topics).values([
      { id: 'topic-a', title: 'A', userId: userA },
      { id: 'topic-b', title: 'B', userId: userB },
    ]);
    await serverDB.insert(messages).values([
      {
        content: 'body-a',
        id: 'msg-a',
        role: 'user',
        topicId: 'topic-a',
        userId: userA,
      },
      {
        content: 'body-b',
        id: 'msg-b',
        role: 'user',
        topicId: 'topic-b',
        userId: userB,
      },
    ]);

    await expect(model.listMessages({ topicId: 'topic-a', userId: '' })).rejects.toThrow(
      /userId and topicId/,
    );

    // Wrong user for topic-a → empty (no cross-user leak)
    const wrongUser = await model.listMessages({ topicId: 'topic-a', userId: userB });
    expect(wrongUser.items).toHaveLength(0);

    const ok = await model.listMessageDetails({ topicId: 'topic-a', userId: userA });
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0]!.content).toBe('body-a');
  });

  it('batches message details across topic ids while preserving user isolation', async () => {
    await serverDB.insert(topics).values([
      { id: 'topic-batch-a', title: 'A', userId: userA },
      { id: 'topic-batch-b', title: 'B', userId: userA },
      { id: 'topic-batch-other', title: 'Other', userId: userB },
    ]);
    await serverDB.insert(messages).values([
      { content: 'a', id: 'msg-batch-a', role: 'user', topicId: 'topic-batch-a', userId: userA },
      { content: 'b', id: 'msg-batch-b', role: 'user', topicId: 'topic-batch-b', userId: userA },
      {
        content: 'other',
        id: 'msg-batch-other',
        role: 'user',
        topicId: 'topic-batch-other',
        userId: userB,
      },
    ]);

    const page = await model.listMessageDetailsForTopics({
      topicIds: ['topic-batch-a', 'topic-batch-b', 'topic-batch-other'],
      userId: userA,
    });
    expect(page.items.map((item) => item.id).sort()).toEqual(['msg-batch-a', 'msg-batch-b']);
    await expect(
      model.listMessageDetailsForTopics({ topicIds: [], userId: userA }),
    ).rejects.toThrow(/userId and topicIds/);
  });

  it('title-only q never matches message body text', async () => {
    await serverDB.insert(topics).values({
      id: 'topic-title',
      title: 'Quarterly report',
      userId: userA,
    });
    await serverDB.insert(messages).values({
      content: 'unique-body-token-xyz',
      id: 'msg-body',
      role: 'user',
      topicId: 'topic-title',
      userId: userA,
    });

    const byTitle = await model.listTopics({ q: 'Quarterly', userId: userA });
    expect(byTitle.items).toHaveLength(1);

    const byBody = await model.listTopics({ q: 'unique-body-token-xyz', userId: userA });
    expect(byBody.items).toHaveLength(0);
  });

  it('keyset-paginates topics', async () => {
    for (let i = 0; i < 3; i++) {
      await serverDB.insert(topics).values({
        id: `topic-page-${i}`,
        title: `T${i}`,
        userId: userA,
      });
    }
    const page1 = await model.listTopics({ limit: 2, userId: userA });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await model.listTopics({
      cursor: page1.nextCursor!,
      limit: 2,
      userId: userA,
    });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    const ids = new Set([...page1.items, ...page2.items].map((t) => t.id));
    expect(ids.size).toBe(page1.items.length + page2.items.length);
  });
});

describe('maskCredentialsInText', () => {
  it('preserves long ordinary business text exactly', () => {
    const ordinary = `Customer ACME Corp discussed roadmap for Q3. Contact Jane Doe at jane.doe@example.com. Phone +1-555-0100. ${'lorem '.repeat(500)}`;
    expect(maskCredentialsInText(ordinary)).toBe(ordinary);
  });

  it('masks credential substrings only', () => {
    const body =
      'Use key sk-abcdefghijklmnopqrstuvwxyz012345 and Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepartok and keep ACME Corp';
    const masked = maskCredentialsInText(body);
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(masked).toContain('[REDACTED]');
    expect(masked).toContain('ACME Corp');
    expect(masked).toContain('Use key');
  });

  it('does not wipe ordinary business keys that merely contain token/secret', () => {
    expect(isCredentialKey('tokenCount')).toBe(false);
    const masked = maskCredentialsDeep({
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      tokenCount: 12,
    });
    expect(masked.tokenCount).toBe(12);
    expect(masked.apiKey).toBe('[REDACTED]');
  });
});
