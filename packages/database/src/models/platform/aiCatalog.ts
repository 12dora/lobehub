import { PlatformAiCatalogRepository } from '../../repositories/platformAiCatalog';
import type {
  PlatformAiModelAbilities,
  PlatformAiModelConfig,
  PlatformAiModelParameters,
  PlatformAiModelPricing,
  PlatformAiModelSettings,
  PlatformAiProviderConfig,
  PlatformAiProviderSettings,
  PlatformResourceStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface PlatformAiSecretState {
  configured: boolean;
  fingerprint: string | null;
  updatedAt: Date | null;
}

export interface PlatformAiModelDraftView {
  abilities: PlatformAiModelAbilities;
  config: PlatformAiModelConfig | null;
  contextWindowTokens: number | null;
  description: string | null;
  displayName: string | null;
  enabled: boolean;
  id: string;
  modelKey: string;
  parameters: PlatformAiModelParameters;
  pricing: PlatformAiModelPricing | null;
  providerId: string;
  revision: number;
  settings: PlatformAiModelSettings;
  sort: number;
  status: PlatformResourceStatus;
  type: string;
}

export interface PlatformAiProviderDraftView {
  checkModel: string | null;
  config: PlatformAiProviderConfig;
  description: string | null;
  displayName: string;
  enabled: boolean;
  fetchOnClient: boolean;
  id: string;
  logo: string | null;
  models: PlatformAiModelDraftView[];
  providerKey: string;
  revision: number;
  secret: PlatformAiSecretState;
  settings: PlatformAiProviderSettings;
  sort: number;
  source: string;
  status: PlatformResourceStatus;
}

/** Snapshot persisted in `platform_resource_revisions`; never contains ciphertext. */
export interface PlatformAiProviderRevisionPayload {
  models: PlatformAiModelDraftView[];
  provider: Omit<PlatformAiProviderDraftView, 'models' | 'secret'> & {
    secretConfigured: boolean;
    secretFingerprint: string | null;
  };
}

const modelView = (
  row: Awaited<ReturnType<PlatformAiCatalogRepository['listModels']>>[number],
) => ({
  abilities: row.abilities ?? {},
  config: row.config ?? null,
  contextWindowTokens: row.contextWindowTokens ?? null,
  description: row.description ?? null,
  displayName: row.displayName ?? null,
  enabled: row.enabled,
  id: row.id,
  modelKey: row.modelKey,
  parameters: row.parameters ?? {},
  pricing: row.pricing ?? null,
  providerId: row.providerId,
  revision: row.revision,
  settings: row.settings ?? {},
  sort: row.sort,
  status: row.status,
  type: row.type,
});

/** Safe aggregate model. Its return values cannot expose `encryptedKeyVaults`. */
export class PlatformAiCatalogModel {
  private readonly repository: PlatformAiCatalogRepository;

  constructor(db: LobeChatDatabase | Transaction) {
    this.repository = new PlatformAiCatalogRepository(db);
  }

  getProvider = async (id: string): Promise<PlatformAiProviderDraftView | undefined> => {
    const provider = await this.repository.getProvider(id);
    if (!provider) return undefined;
    const models = await this.repository.listModels(provider.id);
    return {
      checkModel: provider.checkModel ?? null,
      config: provider.config,
      description: provider.description ?? null,
      displayName: provider.displayName,
      enabled: provider.enabled,
      fetchOnClient: provider.fetchOnClient,
      id: provider.id,
      logo: provider.logo ?? null,
      models: models.map(modelView),
      providerKey: provider.providerKey,
      revision: provider.revision,
      secret: {
        configured: Boolean(provider.encryptedKeyVaults),
        fingerprint: provider.secretFingerprint ?? null,
        updatedAt: provider.secretUpdatedAt ?? null,
      },
      settings: provider.settings,
      sort: provider.sort,
      source: provider.source,
      status: provider.status,
    };
  };

  listProviders = async (params: {
    cursor?: string;
    limit?: number;
    status?: PlatformResourceStatus;
  }) => {
    const page = await this.repository.listProviders(params);
    return {
      items: page.items.map((provider) => ({
        checkModel: provider.checkModel ?? null,
        config: provider.config,
        description: provider.description ?? null,
        displayName: provider.displayName,
        enabled: provider.enabled,
        fetchOnClient: provider.fetchOnClient,
        id: provider.id,
        logo: provider.logo ?? null,
        providerKey: provider.providerKey,
        revision: provider.revision,
        secret: {
          configured: Boolean(provider.encryptedKeyVaults),
          fingerprint: provider.secretFingerprint ?? null,
          updatedAt: provider.secretUpdatedAt ?? null,
        },
        settings: provider.settings,
        sort: provider.sort,
        source: provider.source,
        status: provider.status,
      })),
      nextCursor: page.nextCursor,
    };
  };

  prepareRevisionPayload = async (
    id: string,
  ): Promise<PlatformAiProviderRevisionPayload | null> => {
    const view = await this.getProvider(id);
    if (!view) return null;
    const { models, secret, ...provider } = view;
    return {
      models,
      provider: {
        ...provider,
        secretConfigured: secret.configured,
        secretFingerprint: secret.fingerprint,
      },
    };
  };
}
