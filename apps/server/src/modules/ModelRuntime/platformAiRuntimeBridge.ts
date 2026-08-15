import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState } from '@lobechat/types';
import type { EnabledAiModel, ModelSearchImplementType } from 'model-bank';

import type { LobeChatDatabase } from '@/database/type';

export interface PlatformAiExecutionModel {
  abilities?: { search?: boolean };
  modelKey: string;
  settings?: { searchImpl?: ModelSearchImplementType };
  type: string;
}

export interface PlatformAiExecutionConfig {
  allowedModels: PlatformAiExecutionModel[];
  config: Record<string, unknown>;
  keyVaults: Record<string, Record<string, string> | string | undefined>;
  providerKey: string;
  revision: number;
  runtimeProvider: string;
}

export const assertPlatformPublishedModel = (
  state: AiProviderRuntimeState,
  providerKey: string,
  modelKey: string,
  type: string,
): void => {
  const published = state.enabledAiModels.some(
    (model) =>
      model.enabled &&
      model.providerId === providerKey &&
      model.id === modelKey &&
      model.type === type,
  );
  if (!published) {
    const error = new Error('PLATFORM_AI_MODEL_NOT_PUBLISHED') as Error & {
      code: string;
      errorType: string;
    };
    error.code = 'PLATFORM_AI_MODEL_NOT_PUBLISHED';
    error.errorType = 'PLATFORM_AI_MODEL_NOT_PUBLISHED';
    throw error;
  }
};

/** Secret-free exact model reference used to resolve a historical published provider revision. */
export interface PlatformAiExactModelRef {
  modelKey: string;
  providerChecksum: string;
  providerKey: string;
  providerRevision: number;
}

export interface PlatformAiRuntimeImplementation {
  createModelAllowlistHooks: (models: PlatformAiExecutionModel[]) => ModelRuntimeHooks;
  isEnabled: () => boolean;
  /**
   * True only while the administrator has PUBLISHED 平台托管 for AI providers. The feature
   * flag alone never authorizes the platform to override a user's own configuration.
   */
  isTakeoverActive: (db: LobeChatDatabase) => Promise<boolean>;
  /**
   * Published model set of an ACTIVELY managed provider, or `null` when the provider is not
   * platform-managed right now (never published, disabled, or archived) — `null` and `[]` are
   * different answers: `[]` means "managed, nothing published yet".
   */
  listPublishedModels: (
    db: LobeChatDatabase,
    providerKey: string,
  ) => Promise<EnabledAiModel[] | null>;
  resolveExecutionConfig: (
    db: LobeChatDatabase,
    providerKey: string,
  ) => Promise<PlatformAiExecutionConfig>;
  resolveExecutionConfigAtRevision: (
    db: LobeChatDatabase,
    ref: PlatformAiExactModelRef,
  ) => Promise<PlatformAiExecutionConfig>;
  resolveRuntimeState: (params: {
    db: LobeChatDatabase;
    upstreamState: AiProviderRuntimeState;
  }) => Promise<AiProviderRuntimeState>;
}

let implementation: PlatformAiRuntimeImplementation | null = null;

const envFlagEnabled = (): boolean =>
  ['1', 'true', 'yes', 'on'].includes(
    (process.env.ENABLE_PLATFORM_MANAGED_AI ?? '').trim().toLowerCase(),
  );

const requireImplementation = (): PlatformAiRuntimeImplementation => {
  if (!implementation) throw new Error('PLATFORM_AI_RUNTIME_NOT_REGISTERED');
  return implementation;
};

export const registerPlatformAiRuntime = (next: PlatformAiRuntimeImplementation): void => {
  implementation = next;
};

export const isPlatformManagedAiEnabled = (): boolean =>
  implementation?.isEnabled() ?? envFlagEnabled();

/**
 * Stable seam for upstream (`src/`) and non-enterprise server code: "is the platform AI
 * catalog currently allowed to override this user's providers?". Never true without the
 * feature flag AND a published 平台托管 policy.
 */
export const isPlatformAiTakeoverActive = async (db: LobeChatDatabase): Promise<boolean> => {
  if (!isPlatformManagedAiEnabled()) return false;
  return requireImplementation().isTakeoverActive(db);
};

export const resolvePlatformAiExecutionConfig = (
  db: LobeChatDatabase,
  providerKey: string,
): Promise<PlatformAiExecutionConfig> =>
  requireImplementation().resolveExecutionConfig(db, providerKey);

export const resolvePlatformAiExecutionConfigAtRevision = (
  db: LobeChatDatabase,
  ref: PlatformAiExactModelRef,
): Promise<PlatformAiExecutionConfig> =>
  requireImplementation().resolveExecutionConfigAtRevision(db, ref);

export const resolvePlatformAiRuntimeState = (params: {
  db: LobeChatDatabase;
  upstreamState: AiProviderRuntimeState;
}): Promise<AiProviderRuntimeState> => {
  if (!isPlatformManagedAiEnabled()) return Promise.resolve(params.upstreamState);
  return requireImplementation().resolveRuntimeState(params);
};

export const createPlatformAiModelAllowlistHooks = (
  models: PlatformAiExecutionModel[],
): ModelRuntimeHooks => requireImplementation().createModelAllowlistHooks(models);

export const listPlatformPublishedModels = (
  db: LobeChatDatabase,
  providerKey: string,
): Promise<EnabledAiModel[] | null> => requireImplementation().listPublishedModels(db, providerKey);

export const getEmptyPlatformAiRuntimeState = (): AiProviderRuntimeState => ({
  enabledAiModels: [],
  enabledAiProviders: [],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {},
});
