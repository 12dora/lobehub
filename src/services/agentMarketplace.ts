import type {
  AgentTemplate,
  AgentTemplateFetcher,
  RawAgentTemplate,
} from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import {
  MarketplaceCategory,
  normalizeAgentTemplate,
} from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import i18next from 'i18next';

import { normalizeAsyncError } from '@/libs/swr/normalizeError';
import { lambdaClient } from '@/libs/trpc/client';
import { normalizeLocale } from '@/locales/resources';

const LEGACY_CATEGORY_MAP = {
  academic: MarketplaceCategory.LearningResearch,
  career: MarketplaceCategory.PeopleHR,
  copywriting: MarketplaceCategory.ContentCreation,
  design: MarketplaceCategory.DesignCreative,
  education: MarketplaceCategory.LearningResearch,
  emotions: MarketplaceCategory.PersonalLife,
  entertainment: MarketplaceCategory.PersonalLife,
  games: MarketplaceCategory.PersonalLife,
  general: MarketplaceCategory.BusinessStrategy,
  life: MarketplaceCategory.PersonalLife,
  marketing: MarketplaceCategory.Marketing,
  office: MarketplaceCategory.Operations,
  programming: MarketplaceCategory.Engineering,
  translation: MarketplaceCategory.ContentCreation,
} as const satisfies Record<string, MarketplaceCategory>;

const MAX_LEGACY_TEMPLATES_PER_CATEGORY = 4;
const LEGACY_AGENT_TEMPLATE_ID_PREFIX = 'legacy:';

export const encodeLegacyAgentTemplateId = (identifier: string) =>
  `${LEGACY_AGENT_TEMPLATE_ID_PREFIX}${identifier}`;

export const parseAgentTemplateId = (
  templateId: string,
): { sourceId: string; sourceType: 'legacy' | 'new' } =>
  templateId.startsWith(LEGACY_AGENT_TEMPLATE_ID_PREFIX)
    ? {
        sourceId: templateId.slice(LEGACY_AGENT_TEMPLATE_ID_PREFIX.length),
        sourceType: 'legacy',
      }
    : { sourceId: templateId, sourceType: 'new' };

const resolveMarketplaceLocale = () =>
  normalizeLocale(i18next.resolvedLanguage || i18next.language || globalThis.navigator?.language);

const fetchLegacyAgentTemplates: AgentTemplateFetcher = async (options) => {
  const data = await lambdaClient.market.getAssistantList.query(
    {
      locale: resolveMarketplaceLocale(),
      page: 1,
      pageSize: 500,
      source: 'legacy',
    },
    {
      context: { showNotification: false },
      signal: options?.signal,
    },
  );

  const categoryCounts = new Map<MarketplaceCategory, number>();
  const templates: AgentTemplate[] = [];

  for (const item of data.items) {
    const category = LEGACY_CATEGORY_MAP[item.category as keyof typeof LEGACY_CATEGORY_MAP];
    if (!category || !item.title) continue;

    const count = categoryCounts.get(category) ?? 0;
    if (count >= MAX_LEGACY_TEMPLATES_PER_CATEGORY) continue;

    categoryCounts.set(category, count + 1);
    templates.push({
      avatar: item.avatar,
      category,
      description: item.description,
      id: encodeLegacyAgentTemplateId(item.identifier),
      title: item.title,
    });
  }

  return templates;
};

export const fetchOnboardingAgentTemplates: AgentTemplateFetcher = async (options) => {
  try {
    const data = await lambdaClient.market.agent.getOnboardingFull.query(
      { locale: resolveMarketplaceLocale() },
      {
        context: { showNotification: false },
        signal: options?.signal,
      },
    );
    if (!data || typeof data !== 'object') return [];

    const templates: AgentTemplate[] = [];
    for (const [category, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items as RawAgentTemplate[]) {
        const normalized = normalizeAgentTemplate(item, category);
        if (normalized) templates.push(normalized);
      }
    }

    return templates;
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    const normalizedError = normalizeAsyncError(error);
    if (normalizedError.code !== 'UNAUTHORIZED' && normalizedError.status !== 401) throw error;

    console.warn(
      '[AgentMarketplace] curated onboarding templates require Market authentication, using legacy index',
      error,
    );
    return fetchLegacyAgentTemplates(options);
  }
};
