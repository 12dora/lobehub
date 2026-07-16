import { createHash } from 'node:crypto';

import { isRecord } from '@lobechat/utils/object';
import { AiModelTypeSchema } from 'model-bank';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
  type PublishedAiCatalog,
  publishedAiCatalogSchema,
  type PublishedAiProvider,
} from '../../contracts/aiCatalog';

const EMPTY_CATALOG_REVISION = createHash('sha256').update('[]').digest('hex');

interface RevisionModelPayload {
  abilities?: Record<string, unknown>;
  contextWindowTokens?: number | null;
  description?: string | null;
  displayName?: string | null;
  enabled?: boolean;
  modelKey?: string;
  parameters?: Record<string, unknown>;
  pricing?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  sort?: number;
  type?: string;
}

interface RevisionProviderPayload {
  description?: string | null;
  displayName?: string;
  enabled?: boolean;
  logo?: string | null;
  providerKey?: string;
  sort?: number;
  source?: string;
}

const toPublishedProvider = (
  payload: Record<string, unknown>,
  revision: number,
): PublishedAiProvider | null => {
  const provider = isRecord(payload.provider)
    ? (payload.provider as RevisionProviderPayload)
    : null;
  if (!provider?.enabled || !provider.providerKey || !provider.displayName) return null;
  const rawModels = Array.isArray(payload.models) ? payload.models : [];
  const models = rawModels
    .filter(isRecord)
    .map((model) => model as RevisionModelPayload)
    .filter((model) => model.enabled && model.modelKey)
    .flatMap((model) => {
      const type = AiModelTypeSchema.safeParse(model.type ?? 'chat');
      if (!type.success) return [];
      return [
        {
          abilities: model.abilities ?? {},
          contextWindowTokens: model.contextWindowTokens ?? null,
          description: model.description ?? null,
          displayName: model.displayName ?? null,
          modelKey: model.modelKey!,
          parameters: model.parameters ?? {},
          pricing: model.pricing ?? null,
          settings: model.settings ?? {},
          sort: model.sort ?? 0,
          type: type.data,
        },
      ];
    })
    .sort((a, b) => a.sort - b.sort || a.modelKey.localeCompare(b.modelKey));

  if (models.length === 0) return null;
  return {
    description: provider.description ?? null,
    displayName: provider.displayName,
    logo: provider.logo ?? null,
    models,
    providerKey: provider.providerKey,
    revision,
    sort: provider.sort ?? 0,
    source: provider.source ?? 'custom',
  };
};

/** Published, client-safe AI catalog. Ciphertext and runtime endpoint config never cross this API. */
export class AiCatalogReadService {
  private readonly repository: PlatformAiCatalogRepository;

  constructor(db: LobeChatDatabase) {
    this.repository = new PlatformAiCatalogRepository(db);
  }

  getPublished = async (): Promise<PublishedAiCatalog> => {
    const revisions = await this.repository.listLatestPublishedProviderRevisions();
    const providers = revisions
      .map((revision) => toPublishedProvider(revision.payload, revision.revision))
      .filter((provider): provider is PublishedAiProvider => provider !== null)
      .sort((a, b) => a.sort - b.sort || a.providerKey.localeCompare(b.providerKey));
    const revision =
      providers.length === 0
        ? EMPTY_CATALOG_REVISION
        : createHash('sha256')
            .update(
              providers.map((provider) => `${provider.providerKey}:${provider.revision}`).join('|'),
            )
            .digest('hex');
    return publishedAiCatalogSchema.parse({ providers, revision });
  };
}

export const getEmptyPublishedAiCatalog = (): PublishedAiCatalog => ({
  providers: [],
  revision: EMPTY_CATALOG_REVISION,
});
