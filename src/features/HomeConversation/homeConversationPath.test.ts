import { describe, expect, it } from 'vitest';

import {
  homeConversationTargetFromChatPath,
  homeConversationUrl,
  homeConversationUrlFromChatPath,
} from './homeConversationPath';

describe('homeConversationUrl', () => {
  it('keeps the home pathname and addresses the agent conversation with search params', () => {
    expect(homeConversationUrl({ agentId: 'agt_1', topicId: 'tpc_1' })).toBe(
      '/?agent=agt_1&topic=tpc_1',
    );
  });

  it('supports group conversations', () => {
    expect(homeConversationUrl({ groupId: 'grp_1', topicId: 'tpc_1' })).toBe(
      '/?group=grp_1&topic=tpc_1',
    );
  });

  it('omits the topic param for a fresh conversation', () => {
    expect(homeConversationUrl({ agentId: 'agt_1' })).toBe('/?agent=agt_1');
  });

  it('prefers the group over the agent when both are set', () => {
    expect(homeConversationUrl({ agentId: 'agt_1', groupId: 'grp_1', topicId: 't' })).toBe(
      '/?group=grp_1&topic=t',
    );
  });

  it('falls back to the home landing when there is no conversation target', () => {
    expect(homeConversationUrl({})).toBe('/');
  });
});

describe('homeConversationUrlFromChatPath', () => {
  it('translates agent topic deep links', () => {
    expect(homeConversationUrlFromChatPath('/agent/agt_1/tpc_1')).toBe('/?agent=agt_1&topic=tpc_1');
  });

  it('translates group topic deep links', () => {
    expect(homeConversationUrlFromChatPath('/group/grp_1/tpc_1')).toBe('/?group=grp_1&topic=tpc_1');
  });

  it('translates the topic-less chat roots', () => {
    expect(homeConversationUrlFromChatPath('/agent/agt_1')).toBe('/?agent=agt_1');
    expect(homeConversationUrlFromChatPath('/group/grp_1')).toBe('/?group=grp_1');
  });

  it('leaves agent sub-routes alone — they are not topics', () => {
    expect(homeConversationUrlFromChatPath('/agent/agt_1/profile')).toBeNull();
    expect(homeConversationUrlFromChatPath('/agent/agt_1/task/tsk_1')).toBeNull();
    expect(homeConversationUrlFromChatPath('/agent/agt_1/docs')).toBeNull();
  });

  it('leaves non-chat paths alone', () => {
    expect(homeConversationUrlFromChatPath('/page/doc_1')).toBeNull();
    expect(homeConversationUrlFromChatPath('/task/tsk_1')).toBeNull();
    expect(homeConversationUrlFromChatPath('/')).toBeNull();
  });

  it('exposes the parsed target', () => {
    expect(homeConversationTargetFromChatPath('/agent/agt_1/tpc_1')).toEqual({
      agentId: 'agt_1',
      topicId: 'tpc_1',
    });
  });
});
