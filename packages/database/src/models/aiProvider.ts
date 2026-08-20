import type {
  AiProviderDetailItem,
  AiProviderListItem,
  AiProviderRuntimeConfig,
  CreateAiProviderParams,
  UpdateAiProviderConfigParams,
} from '@lobechat/types';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { isEmpty } from 'es-toolkit/compat';
import { ModelProvider } from 'model-bank';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { merge } from '@/utils/merge';

import type { AiProviderSelectItem } from '../schemas';
import { aiModels, aiProviders } from '../schemas';
import type { LobeChatDatabase } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

type DecryptUserKeyVaults = (encryptKeyVaultsStr: string | null) => Promise<any>;

type EncryptUserKeyVaults = (keyVaults: string) => Promise<string>;

export class AiProviderModel {
  private userId: string;
  private workspaceId?: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.db = db;
  }

  private scopeWhere = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, aiProviders);

  private modelScopeWhere = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, aiModels);

  private values<T extends object>(base: T) {
    return buildWorkspacePayload({ userId: this.userId, workspaceId: this.workspaceId }, base);
  }

  private conflictTarget() {
    return this.workspaceId
      ? {
          target: [aiProviders.id, aiProviders.userId, aiProviders.workspaceId],
          targetWhere: isNotNull(aiProviders.workspaceId),
        }
      : {
          target: [aiProviders.id, aiProviders.userId],
          targetWhere: isNull(aiProviders.workspaceId),
        };
  }

  create = async (
    { keyVaults: userKey, ...params }: CreateAiProviderParams,
    encryptor?: EncryptUserKeyVaults,
  ) => {
    const defaultSerialize = (s: string) => s;
    const encrypt = encryptor ?? defaultSerialize;
    const keyVaults = await encrypt(JSON.stringify(userKey));

    const [result] = await this.db
      .insert(aiProviders)
      .values(
        this.values({
          ...params,
          // each new ai provider we will set it to enabled by default
          enabled: true,
          keyVaults,
        }),
      )
      .returning();

    return result;
  };

  delete = async (id: string) => {
    return this.db.transaction(async (trx) => {
      // 1. delete all models of the provider
      await trx.delete(aiModels).where(and(eq(aiModels.providerId, id), this.modelScopeWhere()));

      // 2. delete the provider
      await trx.delete(aiProviders).where(and(eq(aiProviders.id, id), this.scopeWhere()));
    });
  };

  deleteAll = async () => {
    return this.db.delete(aiProviders).where(this.scopeWhere());
  };

  query = async () => {
    return this.db.query.aiProviders.findMany({
      orderBy: [desc(aiProviders.updatedAt)],
      where: this.scopeWhere(),
    });
  };

  getAiProviderList = async (): Promise<AiProviderListItem[]> => {
    const result = await this.db
      .select({
        description: aiProviders.description,
        enabled: aiProviders.enabled,
        id: aiProviders.id,
        logo: aiProviders.logo,
        name: aiProviders.name,
        sort: aiProviders.sort,
        source: aiProviders.source,
      })
      .from(aiProviders)
      .where(this.scopeWhere())
      .orderBy(asc(aiProviders.sort), desc(aiProviders.updatedAt));

    return result as AiProviderListItem[];
  };

  findById = async (id: string) => {
    return this.db.query.aiProviders.findFirst({
      where: and(eq(aiProviders.id, id), this.scopeWhere()),
    });
  };

  update = async (id: string, value: Partial<AiProviderSelectItem>) => {
    return this.db
      .update(aiProviders)
      .set({ ...value, updatedAt: new Date() })
      .where(and(eq(aiProviders.id, id), this.scopeWhere()));
  };

  updateConfig = async (
    id: string,
    value: UpdateAiProviderConfigParams,
    encryptor?: EncryptUserKeyVaults,
    decryptor?: DecryptUserKeyVaults,
  ) => {
    const defaultSerialize = (s: string) => s;
    const encrypt = encryptor ?? defaultSerialize;
    const decrypt = decryptor ?? JSON.parse;

    // Merge keyVaults with existing values to preserve OAuth tokens
    // when updating from form values that don't include them
    let mergedKeyVaults = value.keyVaults || {};

    const existing = await this.findById(id);
    if (existing?.keyVaults) {
      try {
        const existingKeyVaults = await decrypt(existing.keyVaults);
        // Merge: new values override existing, but preserve fields not in new values
        mergedKeyVaults = { ...existingKeyVaults, ...value.keyVaults };
      } catch {
        // Ignore decryption errors, use new values only
      }
    }

    const keyVaults = await encrypt(JSON.stringify(mergedKeyVaults));

    const commonFields = {
      checkModel: value.checkModel,
      config: value.config,
      fetchOnClient: value.fetchOnClient,
      keyVaults,
    };

    return this.db
      .insert(aiProviders)
      .values(this.values({ ...commonFields, id, source: this.getProviderSource(id) }))
      .onConflictDoUpdate({
        set: commonFields,
        ...this.conflictTarget(),
      });
  };

  toggleProviderEnabled = async (id: string, enabled: boolean) => {
    return this.db
      .insert(aiProviders)
      .values(
        this.values({ enabled, id, source: this.getProviderSource(id), updatedAt: new Date() }),
      )
      .onConflictDoUpdate({
        set: { enabled },
        ...this.conflictTarget(),
      });
  };

  updateOrder = async (sortMap: { id: string; sort: number }[]) => {
    await this.db.transaction(async (tx) => {
      const updates = sortMap.map(({ id, sort }) => {
        return tx
          .insert(aiProviders)
          .values(
            this.values({
              enabled: true,
              id,
              sort,
              source: this.getProviderSource(id),
              updatedAt: new Date(),
            }),
          )
          .onConflictDoUpdate({
            set: { sort, updatedAt: new Date() },
            ...this.conflictTarget(),
          });
      });

      await Promise.all(updates);
    });
  };

  /**
   * Decrypt a stored vault. Missing ciphertext → `{}`. Strict mode (`failOnDecryptError`)
   * distinguishes that from "stored credentials failed to decrypt/parse" so callers
   * never fall through to the deployment env API key.
   */
  private decryptStoredKeyVaults = async (
    encrypted: string | null | undefined,
    decryptor?: DecryptUserKeyVaults,
    failOnDecryptError?: boolean,
  ): Promise<Record<string, unknown>> => {
    if (!encrypted) return {};
    const decrypt = decryptor ?? JSON.parse;
    if (failOnDecryptError) return decrypt(encrypted);
    try {
      return await decrypt(encrypted);
    } catch {
      return {};
    }
  };

  private toAiProviderDetail = (
    result: { fetchOnClient: boolean | null; settings: unknown },
    keyVaults: Record<string, unknown>,
  ): AiProviderDetailItem =>
    ({
      ...result,
      fetchOnClient: typeof result.fetchOnClient === 'boolean' ? result.fetchOnClient : undefined,
      keyVaults,
      settings: isEmpty(result.settings) ? undefined : result.settings,
    }) as AiProviderDetailItem;

  getAiProviderById = async (
    id: string,
    decryptor?: DecryptUserKeyVaults,
    options?: { failOnDecryptError?: boolean },
  ): Promise<AiProviderDetailItem | undefined> => {
    const fetchRow = async () => {
      const [row] = await this.db
        .select({
          checkModel: aiProviders.checkModel,
          config: aiProviders.config,
          description: aiProviders.description,
          enabled: aiProviders.enabled,
          fetchOnClient: aiProviders.fetchOnClient,
          id: aiProviders.id,
          keyVaults: aiProviders.keyVaults,
          logo: aiProviders.logo,
          name: aiProviders.name,
          settings: aiProviders.settings,
          source: aiProviders.source,
        })
        .from(aiProviders)
        .where(and(eq(aiProviders.id, id), this.scopeWhere()))
        .limit(1);
      return row;
    };

    const result = await fetchRow();

    if (!result) {
      // if the provider is builtin but not init, we will insert it to the db
      if (this.isBuiltInProvider(id)) {
        await this.db
          .insert(aiProviders)
          .values(this.values({ id, source: 'builtin' }))
          .onConflictDoNothing();

        const resultAgain = await fetchRow();
        if (!resultAgain) return;

        // Another request may have inserted this builtin with stored credentials
        // between the empty SELECT and onConflictDoNothing — decrypt that row
        // the same way as the hit path (including failOnDecryptError).
        const keyVaults = await this.decryptStoredKeyVaults(
          resultAgain.keyVaults,
          decryptor,
          options?.failOnDecryptError,
        );
        return this.toAiProviderDetail(resultAgain, keyVaults);
      }

      return;
    }

    const keyVaults = await this.decryptStoredKeyVaults(
      result.keyVaults,
      decryptor,
      options?.failOnDecryptError,
    );
    return this.toAiProviderDetail(result, keyVaults);
  };

  getAiProviderRuntimeConfig = async (decryptor?: DecryptUserKeyVaults) => {
    const result = await this.db
      .select({
        config: aiProviders.config,
        fetchOnClient: aiProviders.fetchOnClient,
        id: aiProviders.id,
        keyVaults: aiProviders.keyVaults,
        settings: aiProviders.settings,
      })
      .from(aiProviders)
      .where(this.scopeWhere());

    const decrypt = decryptor ?? JSON.parse;
    const runtimeConfig: Record<string, AiProviderRuntimeConfig> = {};

    for (const item of result) {
      const builtin = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === item.id);

      const userSettings = item.settings || {};

      let keyVaults = {};
      if (!!item.keyVaults) {
        try {
          keyVaults = await decrypt(item.keyVaults);
        } catch {
          /* empty */
        }
      }

      runtimeConfig[item.id] = {
        config: item.config || {},
        fetchOnClient: typeof item.fetchOnClient === 'boolean' ? item.fetchOnClient : undefined,
        keyVaults,
        settings: !!builtin ? merge(builtin.settings, userSettings) : userSettings,
      };
    }

    return runtimeConfig;
  };

  private isBuiltInProvider = (id: string) => Object.values(ModelProvider).includes(id as any);

  private getProviderSource = (id: string) => (this.isBuiltInProvider(id) ? 'builtin' : 'custom');
}
