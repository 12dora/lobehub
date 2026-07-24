import { isRecord } from '@lobechat/utils/object';
import type { AiModelType } from 'model-bank';

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
import { checksumPayload } from './checksum';

/**
 * Internal draft secret state.
 * `fingerprint` is server-only (draft-token / connectivity / secret-version lookup).
 * Client-facing projections must strip it before validating against `aiSecretStateSchema`.
 */
export interface PlatformAiSecretState {
  configured: boolean;
  fingerprint: string | null;
  updatedAt: Date | null;
}

/** Client-safe secret presence — no fingerprint. */
export type PlatformAiPublicSecretState = Pick<PlatformAiSecretState, 'configured' | 'updatedAt'>;

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
  type: AiModelType;
}

export interface PlatformAiProviderDraftView {
  checkModel: string | null;
  config: PlatformAiProviderConfig;
  connectionTest: PlatformAiConnectionTestView | null;
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

export interface PlatformAiConnectionTestView {
  errorCategory: 'auth' | 'network' | 'rate_limit' | 'provider' | 'invalid_config' | null;
  latencyMs: number | null;
  sanitizedMessage: string;
  stale: boolean;
  status: 'pending' | 'success' | 'failure';
  testedAt: Date;
  testedDraftToken: string;
  testedRevision: number;
}

/** Connection-test bookkeeping never changes the catalog draft identity. */
export const platformAiCatalogDraftToken = (draft: PlatformAiProviderDraftView): string => {
  const { connectionTest: _connectionTest, ...catalogDraft } = draft;
  return checksumPayload({ draft: catalogDraft, revision: draft.revision });
};

/** Snapshot persisted in `platform_resource_revisions`; never contains ciphertext. */
export interface PlatformAiProviderRevisionPayload {
  models: PlatformAiModelDraftView[];
  provider: Omit<PlatformAiProviderDraftView, 'connectionTest' | 'models' | 'secret'> & {
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
    return this.toProviderDraftView(provider);
  };

  /** Resolve draft view by user-facing providerKey (O(1) lookup; no list scan). */
  getProviderByKey = async (
    providerKey: string,
  ): Promise<PlatformAiProviderDraftView | undefined> => {
    const provider = await this.repository.getProviderByKey(providerKey);
    if (!provider) return undefined;
    return this.toProviderDraftView(provider);
  };

  /**
   * Bulk draft views: 1 providers query + 1 models query (no per-id N+1).
   * Missing ids/keys are simply absent from the returned array.
   */
  getProvidersBatch = async (input: {
    ids?: string[];
    providerKeys?: string[];
  }): Promise<PlatformAiProviderDraftView[]> => {
    const ids = input.ids ?? [];
    const providerKeys = input.providerKeys ?? [];
    const providers =
      ids.length > 0
        ? await this.repository.getProvidersByIds(ids)
        : await this.repository.getProvidersByKeys(providerKeys);
    if (providers.length === 0) return [];

    const models = await this.repository.listModelsForProviders(providers.map((p) => p.id));
    const modelsByProvider = new Map<string, typeof models>();
    for (const model of models) {
      const bucket = modelsByProvider.get(model.providerId);
      if (bucket) bucket.push(model);
      else modelsByProvider.set(model.providerId, [model]);
    }

    return providers.map((provider) =>
      this.toProviderDraftViewSync(provider, modelsByProvider.get(provider.id) ?? []),
    );
  };

  private toProviderDraftView = async (
    provider: NonNullable<Awaited<ReturnType<PlatformAiCatalogRepository['getProvider']>>>,
  ): Promise<PlatformAiProviderDraftView> => {
    const models = await this.repository.listModels(provider.id);
    return this.toProviderDraftViewSync(provider, models);
  };

  private toProviderDraftViewSync = (
    provider: NonNullable<Awaited<ReturnType<PlatformAiCatalogRepository['getProvider']>>>,
    models: Awaited<ReturnType<PlatformAiCatalogRepository['listModels']>>,
  ): PlatformAiProviderDraftView => {
    const draft: PlatformAiProviderDraftView = {
      checkModel: provider.checkModel ?? null,
      connectionTest:
        provider.connectionTestStatus &&
        provider.connectionTestedAt &&
        provider.connectionTestedDraftToken &&
        provider.connectionTestedRevision !== null
          ? {
              errorCategory: provider.connectionTestErrorCategory ?? null,
              latencyMs: provider.connectionTestLatencyMs ?? null,
              sanitizedMessage: provider.connectionTestSanitizedMessage ?? '',
              stale: false,
              status: provider.connectionTestStatus,
              testedAt: provider.connectionTestedAt,
              testedDraftToken: provider.connectionTestedDraftToken,
              testedRevision: provider.connectionTestedRevision,
            }
          : null,
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
    if (draft.connectionTest) {
      draft.connectionTest.stale =
        draft.connectionTest.testedDraftToken !== platformAiCatalogDraftToken(draft);
    }
    return draft;
  };

  listProviders = async (params: {
    cursor?: string;
    enabled?: boolean;
    limit?: number;
    query?: string;
    source?: string;
    status?: PlatformResourceStatus;
  }) => {
    const page = await this.repository.listProviders(params);
    return {
      items: page.items.map((provider) => ({
        checkModel: provider.checkModel ?? null,
        connectionTest: null,
        config: provider.config,
        description: provider.description ?? null,
        displayName: provider.displayName,
        enabled: provider.enabled,
        fetchOnClient: provider.fetchOnClient,
        id: provider.id,
        logo: provider.logo ?? null,
        providerKey: provider.providerKey,
        revision: provider.revision,
        // List is a client-facing projection: never emit secret fingerprint.
        secret: {
          configured: Boolean(provider.encryptedKeyVaults),
          updatedAt: provider.secretUpdatedAt ?? null,
        } satisfies PlatformAiPublicSecretState,
        settings: provider.settings,
        sort: provider.sort,
        source: provider.source,
        status: provider.status,
      })),
      nextCursor: page.nextCursor,
    };
  };

  listModels = async (params: {
    cursor?: string;
    enabled?: boolean;
    limit?: number;
    provider?: string;
    query?: string;
    status?: PlatformResourceStatus;
    type?: AiModelType;
  }) => {
    const decodedCursor = params.cursor ? this.decodeModelCursor(params.cursor) : undefined;
    const page = await this.repository.listAllModels({
      cursor: decodedCursor,
      enabled: params.enabled,
      limit: params.limit,
      providerKey: params.provider,
      query: params.query,
      status: params.status,
      type: params.type,
    });
    return {
      items: page.items.map(({ model, providerKey }) => ({ ...modelView(model), providerKey })),
      nextCursor: page.nextCursor
        ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url')
        : null,
    };
  };

  private decodeModelCursor = (cursor: string) => {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.modelKey !== 'string' ||
        typeof value.providerKey !== 'string' ||
        typeof value.sort !== 'number' ||
        !Number.isInteger(value.sort)
      ) {
        throw new Error('invalid cursor');
      }
      return {
        id: value.id,
        modelKey: value.modelKey,
        providerKey: value.providerKey,
        sort: value.sort,
      };
    } catch {
      throw new Error('PLATFORM_INVALID_INPUT');
    }
  };

  prepareRevisionPayload = async (
    id: string,
  ): Promise<PlatformAiProviderRevisionPayload | null> => {
    const view = await this.getProvider(id);
    if (!view) return null;
    const { connectionTest: _connectionTest, models, secret, ...provider } = view;
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
