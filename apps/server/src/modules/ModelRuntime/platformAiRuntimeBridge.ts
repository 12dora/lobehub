import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState } from '@lobechat/types';
import type { EnabledAiModel } from 'model-bank';

import type { LobeChatDatabase } from '@/database/type';

export interface PlatformAiExecutionModel {
  modelKey: string;
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
  listPublishedModels: (db: LobeChatDatabase, providerKey: string) => Promise<EnabledAiModel[]>;
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
): Promise<EnabledAiModel[]> => requireImplementation().listPublishedModels(db, providerKey);

export const getEmptyPlatformAiRuntimeState = (): AiProviderRuntimeState => ({
  enabledAiModels: [],
  enabledAiProviders: [],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {},
});

export const resetPlatformAiRuntimeForTest = (): void => {
  implementation = null;
};
