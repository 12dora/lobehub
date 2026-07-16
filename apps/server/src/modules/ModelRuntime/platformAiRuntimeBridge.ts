import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';

export interface PlatformAiExecutionModel {
  modelKey: string;
  type: string;
}

export interface PlatformAiExecutionConfig {
  allowedModels: PlatformAiExecutionModel[];
  config: Record<string, unknown>;
  keyVaults: Record<string, string | undefined>;
  providerKey: string;
  revision: number;
  runtimeProvider: string;
}

export interface PlatformAiRuntimeImplementation {
  createModelAllowlistHooks: (models: PlatformAiExecutionModel[]) => ModelRuntimeHooks;
  isEnabled: () => boolean;
  resolveExecutionConfig: (
    db: LobeChatDatabase,
    providerKey: string,
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
