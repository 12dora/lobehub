/**
 * Takeover-off: session list/count must be the legacy SQL (no visibleAgentIds)
 * and must not touch the platform catalog.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGroupModel } from '@/database/models/chatGroup';
import { SessionModel } from '@/database/models/session';
import { AgentService } from '@/server/services/agent';

import { sessionRouter } from '../session';

vi.mock('@/database/models/session', () => ({
  SessionModel: vi.fn(),
}));

vi.mock('@/database/models/sessionGroup', () => ({
  SessionGroupModel: vi.fn(() => ({})),
}));

vi.mock('@/database/models/chatGroup', () => ({
  ChatGroupModel: vi.fn(),
}));

describe('sessionRouter takeover off', () => {
  const userId = 'session-user';
  let sessionModelMock: {
    count: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    queryByKeyword: ReturnType<typeof vi.fn>;
    queryWithGroups: ReturnType<typeof vi.fn>;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionModelMock = {
      count: vi.fn(async () => 2),
      query: vi.fn(async () => []),
      queryByKeyword: vi.fn(async () => []),
      queryWithGroups: vi.fn(async () => ({ sessionGroups: [], sessions: [] })),
    };
    vi.mocked(SessionModel).mockImplementation(() => sessionModelMock as never);
    vi.mocked(ChatGroupModel).mockImplementation(
      () =>
        ({
          queryWithMemberDetails: vi.fn(async () => []),
        }) as never,
    );
  });

  it('does not pass visibleAgentIds when takeover is off', async () => {
    const caller = sessionRouter.createCaller({ serverDB: {}, userId } as never);

    await caller.countSessions();
    await caller.getSessions({ current: 0, pageSize: 20 });
    await caller.searchSessions({ keywords: 'hi' });
    await caller.getGroupedSessions();

    expect(sessionModelMock.count).toHaveBeenCalledWith(
      expect.objectContaining({ visibleAgentIds: undefined }),
    );
    expect(sessionModelMock.query).toHaveBeenCalledWith(
      expect.objectContaining({ visibleAgentIds: undefined }),
    );
    expect(sessionModelMock.queryByKeyword).toHaveBeenCalledWith('hi', {
      visibleAgentIds: undefined,
    });
    expect(sessionModelMock.queryWithGroups).toHaveBeenCalledWith({
      visibleAgentIds: undefined,
    });
  });

  it('filters chat-group members to the visible set and keeps the group', async () => {
    vi.spyOn(AgentService.prototype, 'getTakeoverVisibleLocalAgentIds').mockResolvedValue(
      new Set(['agt-keep']),
    );
    const queryWithMemberDetails = vi.fn(async () => [
      {
        agents: [
          { id: 'agt-keep', title: 'Keep' },
          { id: 'agt-hide', title: 'Hide' },
        ],
        avatar: null,
        backgroundColor: null,
        description: null,
        groupId: null,
        id: 'grp-1',
        title: 'Team',
        updatedAt: new Date('2024-01-01'),
      },
    ]);
    vi.mocked(ChatGroupModel).mockImplementation(() => ({ queryWithMemberDetails }) as never);

    const caller = sessionRouter.createCaller({ serverDB: {}, userId } as never);
    const result = await caller.getGroupedSessions();
    const group = result.sessions.find((session) => session.id === 'grp-1') as {
      agents?: Array<{ id: string }>;
    };

    expect(group?.agents?.map((agent) => agent.id)).toEqual(['agt-keep']);
  });
});
