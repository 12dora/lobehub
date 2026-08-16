import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ContentModerationConfig,
  ContentModerationSettingsUpdateConfig,
} from '@/types/platform/contentModeration';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';
import { AiCatalogReadService } from '../../../services/aiCatalog/catalogReadService';
import { PlatformRbacService } from '../../../services/platformRbac';

export interface PublishedModerationCatalogModel {
  displayName: string;
  id: string;
}

export interface PublishedModerationCatalogProvider {
  models: PublishedModerationCatalogModel[];
  provider: string;
  providerName: string;
}

export interface ModerationSystemRole {
  displayName?: string;
  name: string;
}

const publishedModelKey = (provider: string, model: string): string => `${provider}/${model}`;

export const loadPublishedModelCatalog = async (
  db: LobeChatDatabase,
): Promise<PublishedModerationCatalogProvider[]> => {
  const catalog = await new AiCatalogReadService(db).getPublished();
  return catalog.providers.map((provider) => ({
    models: provider.models.map((model) => ({
      displayName: model.displayName ?? model.modelKey,
      id: model.modelKey,
    })),
    provider: provider.providerKey,
    providerName: provider.displayName,
  }));
};

export const publishedModelKeySet = (
  catalog: readonly PublishedModerationCatalogProvider[],
): Set<string> => {
  const keys = new Set<string>();
  for (const provider of catalog) {
    for (const model of provider.models) {
      keys.add(publishedModelKey(provider.provider, model.id));
    }
  }
  return keys;
};

export const assertPublishedCatalogModel = (params: {
  catalog: readonly PublishedModerationCatalogProvider[];
  field: string;
  model: string;
  provider: string;
}): void => {
  const keys = publishedModelKeySet(params.catalog);
  if (keys.has(publishedModelKey(params.provider, params.model))) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: params.field,
      model: params.model,
      provider: params.provider,
      reason: 'model_not_published',
    },
  });
};

export const loadSystemRoles = async (db: LobeChatDatabase): Promise<ModerationSystemRole[]> => {
  const roles = await new PlatformRbacService(db).listSystemRoles();
  return roles.map((role) => ({
    displayName: role.name,
    name: role.name,
  }));
};

export const validateCatalogBoundModels = (params: {
  catalog: readonly PublishedModerationCatalogProvider[];
  config: ContentModerationConfig | ContentModerationSettingsUpdateConfig;
}): void => {
  if (params.config.downgrade) {
    assertPublishedCatalogModel({
      catalog: params.catalog,
      field: 'downgrade',
      model: params.config.downgrade.model,
      provider: params.config.downgrade.provider,
    });
  }
  if (params.config.classifier.kind === 'llm_judge' && params.config.classifier.llmJudge) {
    assertPublishedCatalogModel({
      catalog: params.catalog,
      field: 'classifier.llmJudge',
      model: params.config.classifier.llmJudge.model,
      provider: params.config.classifier.llmJudge.provider,
    });
  }
};
