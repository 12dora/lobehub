/**
 * Takeover-off: topic list/count/rank/search must not pass visibleAgentIds.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { ChatGroupModel } from '@/database/models/chatGroup';
import { TopicModel } from '@/database/models/topic';
import { TopicShareModel } from '@/database/models/topicShare';
import { AgentMigrationRepo } from '@/database/repositories/agentMigration';
import { TopicImporterRepo } from '@/database/repositories/topicImporter';

import { topicRouter } from '../topic';

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(),
}));
vi.mock('@/database/models/topicShare', () => ({
  TopicShareModel: vi.fn(),
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn(),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn(),
}));
vi.mock('@/database/models/chatGroup', () => ({
  ChatGroupModel: vi.fn(),
}));
vi.mock('@/database/repositories/agentMigration', () => ({
  AgentMigrationRepo: vi.fn(),
}));
vi.mock('@/database/repositories/topicImporter', () => ({
  TopicImporterRepo: vi.fn(),
}));

describe('topicRouter takeover off', () => {
  const userId = 'topic-user';
  let topicModelMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    topicModelMock = {
      count: vi.fn(async () => 0),
      query: vi.fn(async () => ({ items: [], total: 0 })),
      queryByKeyword: vi.fn(async () => []),
      queryRecent: vi.fn(async () => []),
      queryTopics: vi.fn(async () => []),
      rank: vi.fn(async () => []),
    };
    vi.mocked(TopicModel).mockImplementation(() => topicModelMock as never);
    vi.mocked(TopicShareModel).mockImplementation(() => ({}) as never);
    vi.mocked(AgentModel).mockImplementation(() => ({}) as never);
    vi.mocked(AgentOperationModel).mockImplementation(() => ({}) as never);
    vi.mocked(ChatGroupModel).mockImplementation(() => ({}) as never);
    vi.mocked(AgentMigrationRepo).mockImplementation(() => ({}) as never);
    vi.mocked(TopicImporterRepo).mockImplementation(() => ({}) as never);
  });

  it('does not pass visibleAgentIds when takeover is off', async () => {
    const caller = topicRouter.createCaller({ serverDB: {}, userId } as never);

    await caller.countTopics();
    await caller.hasTopics();
    await caller.queryTopics();
    await caller.rankTopics(5);
    await caller.searchTopics({ keywords: 'hello' });

    expect(topicModelMock.count).toHaveBeenCalledWith(
      expect.objectContaining({ visibleAgentIds: undefined }),
    );
    expect(topicModelMock.queryTopics).toHaveBeenCalledWith(
      expect.objectContaining({ visibleAgentIds: undefined }),
    );
    expect(topicModelMock.rank).toHaveBeenCalledWith(5, undefined);
    expect(topicModelMock.queryByKeyword).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ visibleAgentIds: undefined }),
    );
  });
});
