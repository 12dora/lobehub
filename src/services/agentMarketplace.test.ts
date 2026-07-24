import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeLegacyAgentTemplateId,
  fetchOnboardingAgentTemplates,
  parseAgentTemplateId,
} from './agentMarketplace';

const mocks = vi.hoisted(() => ({
  getAssistantList: vi.fn(),
  getOnboardingFull: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: {
    language: 'en-US',
    resolvedLanguage: 'zh',
  },
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    market: {
      getAssistantList: {
        query: mocks.getAssistantList,
      },
      agent: {
        getOnboardingFull: {
          query: mocks.getOnboardingFull,
        },
      },
    },
  },
}));

describe('fetchOnboardingAgentTemplates', () => {
  beforeEach(() => {
    mocks.getAssistantList.mockReset();
    mocks.getOnboardingFull.mockReset();
  });

  it('requests onboarding marketplace templates with the normalized current locale', async () => {
    const signal = new AbortController().signal;
    mocks.getOnboardingFull.mockResolvedValue({
      engineering: [
        {
          description: 'Helps with code',
          identifier: 'agent-template-engineer',
          name: 'Engineer',
        },
      ],
    });

    const result = await fetchOnboardingAgentTemplates({ signal });

    expect(mocks.getOnboardingFull).toHaveBeenCalledWith(
      { locale: 'zh-CN' },
      { context: { showNotification: false }, signal },
    );
    expect(result).toEqual([
      {
        category: 'engineering',
        description: 'Helps with code',
        id: 'agent-template-engineer',
        title: 'Engineer',
      },
    ]);
  });

  it('falls back to a capped legacy template list when the curated endpoint is unauthorized', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getOnboardingFull.mockRejectedValue({
      data: { code: 'UNAUTHORIZED', httpStatus: 401 },
      message: 'MARKET_ONBOARDING_AUTH_REQUIRED',
    });
    mocks.getAssistantList.mockResolvedValue({
      currentPage: 1,
      items: [
        ...Array.from({ length: 5 }, (_, index) => ({
          avatar: `avatar-${index}`,
          category: 'programming',
          description: `description-${index}`,
          identifier: `engineer-${index}`,
          title: `Engineer ${index}`,
        })),
        {
          avatar: 'writer',
          category: 'copywriting',
          description: 'Writes content',
          identifier: 'writer',
          title: 'Writer',
        },
        {
          category: 'unknown',
          identifier: 'unknown',
          title: 'Unknown',
        },
      ],
      pageSize: 500,
      totalCount: 7,
      totalPages: 1,
    });

    const result = await fetchOnboardingAgentTemplates();

    expect(mocks.getAssistantList).toHaveBeenCalledWith(
      { locale: 'zh-CN', page: 1, pageSize: 500, source: 'legacy' },
      { context: { showNotification: false }, signal: undefined },
    );
    expect(result).toHaveLength(5);
    expect(result.filter((item) => item.category === 'engineering')).toHaveLength(4);
    expect(result).toContainEqual({
      avatar: 'writer',
      category: 'content-creation',
      description: 'Writes content',
      id: 'legacy:writer',
      title: 'Writer',
    });
    consoleWarnSpy.mockRestore();
  });

  it('does not hide non-authentication failures behind the legacy fallback', async () => {
    mocks.getOnboardingFull.mockRejectedValue({
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
      message: 'Market unavailable',
    });

    await expect(fetchOnboardingAgentTemplates()).rejects.toMatchObject({
      message: 'Market unavailable',
    });

    expect(mocks.getAssistantList).not.toHaveBeenCalled();
  });

  it('does not start the fallback request after an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.getOnboardingFull.mockRejectedValue(new Error('Aborted'));

    await expect(fetchOnboardingAgentTemplates({ signal: controller.signal })).rejects.toThrow(
      'Aborted',
    );

    expect(mocks.getAssistantList).not.toHaveBeenCalled();
  });
});

describe('agent template source ids', () => {
  it('round-trips legacy identifiers without changing Market identifiers', () => {
    expect(encodeLegacyAgentTemplateId('code-reviewer')).toBe('legacy:code-reviewer');
    expect(parseAgentTemplateId('legacy:code-reviewer')).toEqual({
      sourceId: 'code-reviewer',
      sourceType: 'legacy',
    });
    expect(parseAgentTemplateId('agent-template-code-reviewer')).toEqual({
      sourceId: 'agent-template-code-reviewer',
      sourceType: 'new',
    });
  });
});
