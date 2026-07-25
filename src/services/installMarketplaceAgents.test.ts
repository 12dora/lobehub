import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentService } from '@/services/agent';
import { discoverService } from '@/services/discover';
import { marketApiService } from '@/services/marketApi';
import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

import { installMarketplaceAgents } from './installMarketplaceAgents';

describe('installMarketplaceAgents', () => {
  const createAgent = vi.fn();
  const refreshAgentList = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    createAgent.mockReset();
    refreshAgentList.mockReset();
    refreshAgentList.mockResolvedValue(undefined);

    vi.spyOn(useAgentStore, 'getState').mockReturnValue({
      createAgent,
    } as unknown as ReturnType<typeof useAgentStore.getState>);
    vi.spyOn(useHomeStore, 'getState').mockReturnValue({
      refreshAgentList,
    } as unknown as ReturnType<typeof useHomeStore.getState>);
    vi.spyOn(discoverService, 'reportAgentEvent').mockResolvedValue(undefined);
  });

  it('sends a single batched fork call carrying every selected agent', async () => {
    const sourceIds = ['src-a', 'src-b', 'src-c'];

    vi.spyOn(agentService, 'getAgentByForkedFromIdentifier').mockResolvedValue(null);
    vi.spyOn(discoverService, 'getAssistantDetail').mockImplementation(
      async ({ identifier, source }) =>
        source === 'legacy'
          ? undefined
          : ({
              avatar: 'avatar',
              backgroundColor: '#fff',
              category: 'engineering',
              config: { params: {} } as any,
              description: `desc-${identifier}`,
              editorData: {},
              identifier,
              summary: `summary-${identifier}`,
              tags: [],
              title: `Title-${identifier}`,
            } as any),
    );

    const forkSpy = vi.spyOn(marketApiService, 'forkAgent').mockImplementation(async (items) =>
      items.map((item) => ({
        data: {
          agent: {
            createdAt: '2026-01-01',
            forkedFromAgentId: 1,
            id: 1,
            identifier: item.identifier,
            name: item.name ?? '',
            ownerId: 1,
            updatedAt: '2026-01-01',
          },
          source: { agentId: 1, identifier: item.sourceIdentifier, versionNumber: 1 },
          version: { agentId: 1, createdAt: '2026-01-01', id: 1, versionNumber: 1 },
        },
        sourceIdentifier: item.sourceIdentifier,
        success: true as const,
      })),
    );

    createAgent.mockImplementation(async ({ config }: any) => ({
      agentId: `agent-${config.params.forkedFromIdentifier}`,
    }));

    const result = await installMarketplaceAgents(sourceIds);

    expect(forkSpy).toHaveBeenCalledTimes(1);
    const [items] = forkSpy.mock.calls[0];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.sourceIdentifier)).toEqual(sourceIds);

    expect(createAgent).toHaveBeenCalledTimes(3);
    expect(result.installedAgentIds).toHaveLength(3);
    expect(result.skippedAgentIds).toEqual([]);
    expect(refreshAgentList).toHaveBeenCalledTimes(1);
  });

  it('skips already-forked agents at the dedupe step', async () => {
    const sourceIds = ['src-a', 'src-b', 'src-c'];

    vi.spyOn(agentService, 'getAgentByForkedFromIdentifier').mockImplementation(async (id) =>
      id === 'src-a' ? null : `existing-${id}`,
    );
    vi.spyOn(discoverService, 'getAssistantDetail').mockImplementation(
      async ({ identifier, source }) =>
        source === 'legacy'
          ? undefined
          : ({
              avatar: 'a',
              backgroundColor: '#fff',
              category: 'engineering',
              config: { params: {} } as any,
              description: 'd',
              editorData: {},
              identifier,
              summary: 's',
              tags: [],
              title: 'T',
            } as any),
    );
    const forkSpy = vi.spyOn(marketApiService, 'forkAgent').mockImplementation(async (items) =>
      items.map((item) => ({
        data: {
          agent: {
            createdAt: '',
            forkedFromAgentId: 1,
            id: 1,
            identifier: item.identifier,
            name: item.name ?? '',
            ownerId: 1,
            updatedAt: '',
          },
          source: { agentId: 1, identifier: item.sourceIdentifier, versionNumber: 1 },
          version: { agentId: 1, createdAt: '', id: 1, versionNumber: 1 },
        },
        sourceIdentifier: item.sourceIdentifier,
        success: true as const,
      })),
    );
    createAgent.mockImplementation(async ({ config }: any) => ({
      agentId: `agent-${config.params.forkedFromIdentifier}`,
    }));

    const result = await installMarketplaceAgents(sourceIds);

    expect(forkSpy).toHaveBeenCalledTimes(1);
    const [items] = forkSpy.mock.calls[0];
    expect(items.map((i) => i.sourceIdentifier)).toEqual(['src-a']);
    expect(result.skippedAgentIds).toEqual(['src-b', 'src-c']);
    expect(result.installedAgentIds).toEqual(['agent-src-a']);
  });

  it('copies legacy templates locally without requiring a Market fork', async () => {
    vi.spyOn(agentService, 'getAgentByForkedFromIdentifier').mockResolvedValue(null);
    vi.spyOn(discoverService, 'getAssistantDetail').mockImplementation(
      async ({ identifier, source }) =>
        source === 'legacy'
          ? ({
              avatar: '🤖',
              backgroundColor: '#fff',
              category: 'programming',
              config: { params: {}, systemRole: 'Review code' } as any,
              description: 'Reviews code',
              editorData: {},
              identifier,
              summary: 'Reviews code',
              tags: ['code'],
              title: 'Code Reviewer',
            } as any)
          : undefined,
    );
    const forkSpy = vi.spyOn(marketApiService, 'forkAgent');
    createAgent.mockResolvedValue({ agentId: 'local-agent' });

    const result = await installMarketplaceAgents(['legacy:legacy-reviewer']);

    expect(forkSpy).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith({
      config: expect.objectContaining({
        avatar: '🤖',
        params: { forkedFromIdentifier: 'legacy:legacy-reviewer' },
        systemRole: 'Review code',
        title: 'Code Reviewer',
      }),
      visibility: undefined,
    });
    expect(createAgent.mock.calls[0][0].config).not.toHaveProperty('marketIdentifier');
    expect(result.installedAgentIds).toEqual(['local-agent']);
    expect(result.summaries[0]).toEqual(
      expect.objectContaining({
        installedAgentId: 'local-agent',
        templateId: 'legacy:legacy-reviewer',
      }),
    );
    expect(refreshAgentList).toHaveBeenCalledTimes(1);
  });

  it('does not attribute a Market fork to a legacy template that shares a sourceId', async () => {
    vi.spyOn(agentService, 'getAgentByForkedFromIdentifier').mockResolvedValue(null);
    vi.spyOn(discoverService, 'getAssistantDetail').mockImplementation(
      async ({ identifier, source }) => {
        if (source === 'legacy' && identifier === 'writer') {
          return {
            avatar: 'L',
            backgroundColor: '#111',
            category: 'writing',
            config: { params: {}, systemRole: 'Legacy writer' } as any,
            description: 'Legacy writer',
            editorData: {},
            identifier,
            summary: 'Legacy writer',
            tags: ['legacy'],
            title: 'Legacy Writer',
          } as any;
        }
        if (source === 'new' && identifier === 'writer') {
          return {
            avatar: 'N',
            backgroundColor: '#222',
            category: 'writing',
            config: { params: {}, systemRole: 'Market writer' } as any,
            description: 'Market writer',
            editorData: {},
            identifier,
            summary: 'Market writer',
            tags: ['market'],
            title: 'Market Writer',
          } as any;
        }
        return undefined;
      },
    );
    vi.spyOn(marketApiService, 'forkAgent').mockResolvedValue([
      {
        data: {
          agent: { identifier: 'forked-market-writer', name: 'Forked Market Writer' },
        },
        sourceIdentifier: 'writer',
        success: true,
      },
    ] as any);
    createAgent
      .mockResolvedValueOnce({ agentId: 'agent-legacy' })
      .mockResolvedValueOnce({ agentId: 'agent-new' });

    const reportSpy = vi.spyOn(discoverService, 'reportAgentEvent').mockResolvedValue(undefined);

    await installMarketplaceAgents(['legacy:writer', 'writer']);

    const legacyCall = createAgent.mock.calls.find(
      (call) => call[0].config.params?.forkedFromIdentifier === 'legacy:writer',
    );
    const newCall = createAgent.mock.calls.find(
      (call) => call[0].config.params?.forkedFromIdentifier === 'writer',
    );

    expect(legacyCall?.[0].config).toEqual(
      expect.objectContaining({
        title: 'Legacy Writer',
      }),
    );
    expect(legacyCall?.[0].config).not.toHaveProperty('marketIdentifier');
    expect(newCall?.[0].config).toEqual(
      expect.objectContaining({
        marketIdentifier: 'forked-market-writer',
        title: 'Forked Market Writer',
      }),
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'add',
        identifier: 'forked-market-writer',
      }),
    );
  });
});
