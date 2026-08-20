import { describe, expect, it } from 'vitest';

import { type RecentItem } from '@/server/routers/lambda/recent';

import { getRecentRoute } from './recentRoute';

const item = (partial: Partial<RecentItem> & Pick<RecentItem, 'type'>): RecentItem => ({
  agentId: null,
  icon: partial.type,
  id: 'id_1',
  routePath: '/',
  status: null,
  title: 'title',
  updatedAt: new Date(0),
  ...partial,
});

describe('getRecentRoute', () => {
  it('opens agent topics in the home shell instead of /agent/:aid/:topicId', () => {
    expect(
      getRecentRoute(
        item({ agentId: 'agt_1', id: 'tpc_1', routePath: '/agent/agt_1/tpc_1', type: 'topic' }),
      ),
    ).toBe('/?agent=agt_1&topic=tpc_1');
  });

  it('opens group topics in the home shell instead of /group/:gid/:topicId', () => {
    expect(
      getRecentRoute(item({ id: 'tpc_1', routePath: '/group/grp_1/tpc_1', type: 'topic' })),
    ).toBe('/?group=grp_1&topic=tpc_1');
  });

  it('falls back to the server route when a topic has no chat path', () => {
    expect(getRecentRoute(item({ id: 'tpc_1', routePath: '/', type: 'topic' }))).toBe('/');
  });

  it('keeps documents on /page/:id', () => {
    expect(getRecentRoute(item({ id: 'doc_1', routePath: '/page/doc_1', type: 'document' }))).toBe(
      '/page/doc_1',
    );
  });

  it('keeps tasks on their task detail route', () => {
    expect(
      getRecentRoute(
        item({ agentId: 'agt_1', id: 'tsk_1', routePath: '/agent/agt_1/task/tsk_1', type: 'task' }),
      ),
    ).toBe('/agent/agt_1/task/tsk_1');
  });
});
