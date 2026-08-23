/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';

const { findByIds, queryRoleContentByTopicIds, serverMessagesEngine } = vi.hoisted(() => ({
  findByIds: vi.fn(),
  queryRoleContentByTopicIds: vi.fn(),
  serverMessagesEngine: vi.fn(async (input: { messages: unknown[] }) => input.messages),
}));

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine }));

vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    findByIds = findByIds;
  },
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    queryRoleContentByTopicIds = queryRoleContentByTopicIds;
  },
}));

vi.mock('./serverCallLlmContextHints', () => ({
  resolveServerCallLlmContextHints: vi.fn(async ({ llmPayload }) => ({
    capabilities: { isCanUseFiles: () => false },
    messagesForContext: llmPayload.messages,
    modelDisplayName: 'model',
    modelKnowledgeCutoff: '2025-01',
    preserveThinkingForPayload: false,
    resolvedExtendParams: undefined,
    shouldReplayAssistantReasoning: false,
  })),
}));

const dummyServerDB = {
  select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
};

describe('buildServerCallLlmContext — topic reference batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByIds.mockResolvedValue(
      new Map([
        ['t1', { historySummary: 'sum', id: 't1', title: 'One' }],
        ['t2', { historySummary: null, id: 't2', title: 'Two' }],
      ]),
    );
    queryRoleContentByTopicIds.mockResolvedValue(
      new Map([['t2', [{ content: 'hi', role: 'user' }]]]),
    );
  });

  it('uses findByIds + queryRoleContentByTopicIds instead of per-topic findById/query', async () => {
    await buildServerCallLlmContext({
      ctx: {
        agentConfig: { chatConfig: {}, files: [], knowledgeBases: [], systemRole: 's' },
        serverDB: dummyServerDB,
        userId: 'u1',
        workspaceId: undefined,
      } as never,
      llmPayload: {
        messages: [
          {
            content: '<refer_topic name="A" id="t1" /><refer_topic name="B" id="t2" />',
            role: 'user',
          },
        ],
      } as never,
      model: 'm',
      provider: 'p',
      state: { metadata: {} } as never,
      tooling: { resolved: { enabledToolIds: [], promptManifestMap: {} } } as never,
    });

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findByIds).toHaveBeenCalledWith(['t1', 't2']);
    expect(queryRoleContentByTopicIds).toHaveBeenCalledTimes(1);
    expect(queryRoleContentByTopicIds).toHaveBeenCalledWith(['t2']);

    const input = serverMessagesEngine.mock.calls[0][0] as unknown as {
      topicReferences: Array<{ topicId: string }>;
    };
    expect(input.topicReferences.map((ref) => ref.topicId)).toEqual(['t1', 't2']);
  });

  it('preserves missing/forbidden topics as title-only refs', async () => {
    findByIds.mockResolvedValue(new Map());
    queryRoleContentByTopicIds.mockResolvedValue(new Map());

    await buildServerCallLlmContext({
      ctx: {
        agentConfig: { chatConfig: {}, files: [], knowledgeBases: [], systemRole: 's' },
        serverDB: dummyServerDB,
        userId: 'u1',
      } as never,
      llmPayload: {
        messages: [{ content: '<refer_topic name="Gone" id="missing" />', role: 'user' }],
      } as never,
      model: 'm',
      provider: 'p',
      state: { metadata: {} } as never,
      tooling: { resolved: { enabledToolIds: [], promptManifestMap: {} } } as never,
    });

    const input = serverMessagesEngine.mock.calls[0][0] as unknown as {
      topicReferences: Array<{ topicId: string; topicTitle?: string }>;
    };
    expect(input.topicReferences).toEqual([{ topicId: 'missing', topicTitle: 'Gone' }]);
  });
});
