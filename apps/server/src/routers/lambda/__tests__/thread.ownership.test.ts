// @vitest-environment node
import { ThreadType } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { getServerDB } from '@/database/core/db-adaptor';
import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { TopicModel } from '@/database/models/topic';

import { threadRouter } from '../thread';

vi.mock('@/database/models/thread');
vi.mock('@/database/models/topic');
vi.mock('@/database/models/message');
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(),
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    getTakeoverVisibleLocalAgentIds: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('threadRouter ownership and atomic create', () => {
  it('creates the thread and message inside one transaction', async () => {
    const trx = { id: 'trx' };
    const transaction = vi.fn(async (run: (tx: typeof trx) => Promise<unknown>) => run(trx));
    const create = vi.fn().mockResolvedValue({ id: 'thd-1' });
    const createWithTransaction = vi.fn().mockResolvedValue({ id: 'msg-1' });

    vi.mocked(ThreadModel).mockImplementation(() => ({ create }) as never);
    vi.mocked(MessageModel).mockImplementation(() => ({ createWithTransaction }) as never);
    vi.mocked(TopicModel).mockImplementation(() => ({}) as never);
    vi.mocked(getServerDB).mockResolvedValue({ transaction } as never);

    const caller = threadRouter.createCaller({
      userId: 'u1',
    } as never);

    await expect(
      caller.createThreadWithMessage({
        message: { content: 'hello', role: 'user' },
        topicId: 'topic-owned',
        type: ThreadType.Standalone,
      }),
    ).resolves.toEqual({ messageId: 'msg-1', threadId: 'thd-1' });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 'topic-owned', type: ThreadType.Standalone }),
      trx,
    );
    expect(createWithTransaction).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({
        content: 'hello',
        threadId: 'thd-1',
        topicId: 'topic-owned',
      }),
    );
  });

  it('does not keep a thread when the message insert is rejected', async () => {
    const trx = { id: 'trx' };
    const transaction = vi.fn(async (run: (tx: typeof trx) => Promise<unknown>) => run(trx));
    const create = vi.fn().mockResolvedValue({ id: 'thd-orphan' });
    const createWithTransaction = vi.fn().mockRejectedValue(new Error('Topic not found'));

    vi.mocked(ThreadModel).mockImplementation(() => ({ create }) as never);
    vi.mocked(MessageModel).mockImplementation(() => ({ createWithTransaction }) as never);
    vi.mocked(TopicModel).mockImplementation(() => ({}) as never);
    vi.mocked(getServerDB).mockResolvedValue({ transaction } as never);

    const caller = threadRouter.createCaller({
      userId: 'u1',
    } as never);

    await expect(
      caller.createThreadWithMessage({
        message: { content: 'graft', role: 'user', topicId: 'foreign-topic' },
        topicId: 'topic-owned',
        type: ThreadType.Standalone,
      }),
    ).rejects.toThrow('Topic not found');

    expect(create).toHaveBeenCalled();
    expect(createWithTransaction).toHaveBeenCalled();
  });

  it('rejects association fields on updateThread', async () => {
    const update = vi.fn();
    vi.mocked(ThreadModel).mockImplementation(() => ({ update }) as never);
    vi.mocked(TopicModel).mockImplementation(() => ({}) as never);
    vi.mocked(MessageModel).mockImplementation(() => ({}) as never);

    const caller = threadRouter.createCaller({
      serverDB: {},
      userId: 'u1',
    } as never);

    await expect(
      caller.updateThread({
        id: 'thd-1',
        value: { title: 'x', topicId: 'foreign-topic' } as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(update).not.toHaveBeenCalled();
  });
});
