/**
 * Takeover-off: getThreads must not load the parent topic, and getThread must
 * use the unfiltered query. No platform catalog I/O.
 *
 * @vitest-environment node
 */
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { TopicModel } from '@/database/models/topic';
import { AgentService } from '@/server/services/agent';

import { resolveAgentIdFromSession } from '../_helpers/resolveContext';
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

vi.mock('../_helpers/resolveContext', () => ({
  resolveAgentIdFromSession: vi.fn(),
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

describe('threadRouter takeover on', () => {
  const userId = 'thread-user';
  let threadModelMock: { queryByTopicId: ReturnType<typeof vi.fn> };
  let topicModelMock: { findById: ReturnType<typeof vi.fn> };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    threadModelMock = {
      queryByTopicId: vi.fn(async () => [{ id: 'thd-1' }]),
    };
    topicModelMock = { findById: vi.fn() };
    vi.mocked(ThreadModel).mockImplementation(() => threadModelMock as never);
    vi.mocked(TopicModel).mockImplementation(() => topicModelMock as never);
    vi.mocked(MessageModel).mockImplementation(() => ({}) as never);
    vi.spyOn(AgentService.prototype, 'getTakeoverVisibleLocalAgentIds').mockResolvedValue(
      new Set(['agt-ok']),
    );
  });

  it('resolves a legacy topic via session agent and authorizes it', async () => {
    topicModelMock.findById.mockResolvedValue({
      agentId: null,
      groupId: null,
      id: 'topic-legacy',
      sessionId: 'ses-1',
    });
    vi.mocked(resolveAgentIdFromSession).mockResolvedValue('agt-ok');
    const assertReadable = vi
      .spyOn(AgentService.prototype, 'assertAgentReadable')
      .mockResolvedValue(undefined);

    const caller = threadRouter.createCaller({ serverDB: {}, userId } as never);
    await caller.getThreads({ topicId: 'topic-legacy' });

    expect(resolveAgentIdFromSession).toHaveBeenCalledWith('ses-1', {}, userId, undefined);
    expect(assertReadable).toHaveBeenCalledWith('agt-ok');
    expect(threadModelMock.queryByTopicId).toHaveBeenCalledWith('topic-legacy');
  });

  it('denies unresolved non-group parents under takeover', async () => {
    topicModelMock.findById.mockResolvedValue({
      agentId: null,
      groupId: null,
      id: 'topic-orphan',
      sessionId: null,
    });

    const caller = threadRouter.createCaller({ serverDB: {}, userId } as never);
    const error = await caller.getThreads({ topicId: 'topic-orphan' }).then(
      () => {
        throw new Error('expected getThreads to deny the unresolved topic');
      },
      (e) => e,
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect((error as TRPCError).message).toBe(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);
    expect(threadModelMock.queryByTopicId).not.toHaveBeenCalled();
  });
});
