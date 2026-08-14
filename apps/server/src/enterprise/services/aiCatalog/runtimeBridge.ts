import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import {
  type PlatformAiRuntimeImplementation,
  registerPlatformAiRuntime,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import {
  AiCatalogExecutionResolver,
  createAiCatalogModelAllowlistHooks,
  resolveAiCatalogRuntimeState,
} from './runtimeAdapter';

let registered = false;

export const ensurePlatformAiRuntimeRegistered = (): void => {
  if (registered) return;
  const implementation: PlatformAiRuntimeImplementation = {
    createModelAllowlistHooks: createAiCatalogModelAllowlistHooks,
    isEnabled: () => parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AI,
    listPublishedModels: async (db, providerKey) => {
      const state = await resolveAiCatalogRuntimeState({
        db,
        upstreamState: {
          enabledAiModels: [],
          enabledAiProviders: [],
          enabledChatAiProviders: [],
          enabledImageAiProviders: [],
          enabledVideoAiProviders: [],
          runtimeConfig: {},
        },
      });
      // Not in the published snapshot ⇒ not actively managed; the caller must fall back to
      // the user's own (BYOK) view rather than treat the provider as an empty catalog.
      const managed = state.enabledAiProviders.some((provider) => provider.id === providerKey);
      if (!managed) return null;
      return state.enabledAiModels.filter((model) => model.providerId === providerKey);
    },
    resolveExecutionConfig: async (db, providerKey) => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
      if (!secrets) throw new Error('PLATFORM_SECRET_REQUIRED');
      return new AiCatalogExecutionResolver(db, secrets).resolveProviderExecutionConfig(
        providerKey,
      );
    },
    resolveExecutionConfigAtRevision: async (db, ref) => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
      if (!secrets) throw new Error('PLATFORM_SECRET_REQUIRED');
      return new AiCatalogExecutionResolver(db, secrets).resolveProviderExecutionConfigAtRevision(
        ref,
      );
    },
    resolveRuntimeState: ({ db, upstreamState }) =>
      resolveAiCatalogRuntimeState({ db, upstreamState }),
  };
  registerPlatformAiRuntime(implementation);
  registered = true;
};
