import { isRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import type {
  NewPlatformAiModel,
  PlatformAiModelAbilities,
  PlatformAiModelConfig,
  PlatformAiModelParameters,
  PlatformAiModelPricing,
  PlatformAiModelSettings,
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
  PlatformRevisionStatus,
} from '@/database/schemas/platform';

import type { aiModelDraftSchema } from '../../contracts/aiCatalog';

type PublishedModelDraft = z.infer<typeof aiModelDraftSchema>;

export const coercePublishedProviderColumns = (provider: Record<string, unknown>) => ({
  checkModel: typeof provider.checkModel === 'string' ? provider.checkModel : null,
  config: isRecord(provider.config) ? (provider.config as PlatformAiProviderConfig) : {},
  description: typeof provider.description === 'string' ? provider.description : null,
  displayName: typeof provider.displayName === 'string' ? provider.displayName : 'Unnamed provider',
  enabled: provider.enabled === true,
  fetchOnClient: provider.fetchOnClient === true,
  logo: typeof provider.logo === 'string' ? provider.logo : null,
  settings: isRecord(provider.settings) ? (provider.settings as PlatformAiProviderSettings) : {},
  sort: typeof provider.sort === 'number' ? provider.sort : 0,
  source: typeof provider.source === 'string' ? provider.source : 'custom',
});

export const toPublishedModelRows = (
  models: PublishedModelDraft[],
  params: {
    actorUserId: string;
    providerId: string;
    revision: number;
    status: PlatformRevisionStatus;
  },
): NewPlatformAiModel[] =>
  models.map((model) => ({
    ...model,
    abilities: model.abilities as PlatformAiModelAbilities,
    config: model.config as PlatformAiModelConfig | null,
    parameters: model.parameters as PlatformAiModelParameters,
    pricing: model.pricing as PlatformAiModelPricing | null,
    providerId: params.providerId,
    publishedAt: params.status === 'published' ? new Date() : null,
    revision: params.revision,
    settings: model.settings as PlatformAiModelSettings,
    status: params.status === 'archived' ? 'archived' : 'published',
    updatedBy: params.actorUserId,
  }));
