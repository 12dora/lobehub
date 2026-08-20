/**
 * Takeover-off: getThreads must not load the parent topic, and getThread must
 * use the unfiltered query. No platform catalog I/O.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { TopicModel } from '@/database/models/topic';

import { threadRouter } from '../thread';

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn(),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(),
}));

describe('threadRouter takeover off', () => {
  const userId = 'thread-user';
  let threadModelMock: {
    query: ReturnType<typeof vi.fn>;
    queryByTopicId: ReturnType<typeof vi.fn>;
  };
  let topicModelMock: { findById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    threadModelMock = {
      query: vi.fn(async () => [{ id: 'thd-1' }]),
      queryByTopicId: vi.fn(async () => [{ id: 'thd-1' }]),
    };
    topicModelMock = {
      findById: vi.fn(async () => ({ agentId: 'agt_hidden', id: 'topic-1' })),
    };
    vi.mocked(ThreadModel).mockImplementation(() => threadModelMock as never);
    vi.mocked(TopicModel).mockImplementation(() => topicModelMock as never);
    vi.mocked(MessageModel).mockImplementation(() => ({}) as never);
  });

  it('getThreads skips TopicModel.findById when takeover is off', async () => {
    const caller = threadRouter.createCaller({ serverDB: {}, userId } as never);
    await caller.getThreads({ topicId: 'topic-1' });

    expect(topicModelMock.findById).not.toHaveBeenCalled();
    expect(threadModelMock.queryByTopicId).toHaveBeenCalledWith('topic-1');
  });

  it('getThread uses the legacy query with no visibleAgentIds', async () => {
    const caller = threadRouter.createCaller({ serverDB: {}, userId } as never);
    await caller.getThread();

    expect(threadModelMock.query).toHaveBeenCalledWith();
  });
});
