import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { wrapModelRuntimeWithModeration } from '@/server/enterprise/services/contentModeration/runtime';
import { isBootModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import {
  type PlatformAiRuntimeImplementation,
  registerPlatformAiRuntime,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import { isPlatformAiTakeoverActive } from './enforcement';
import { AiCatalogNotFoundError } from './errors';
import {
  AiCatalogExecutionResolver,
  createAiCatalogModelAllowlistHooks,
  resolveAiCatalogRuntimeState,
} from './runtimeAdapter';
import { AiCatalogSecretManager } from './secretManager';
import {
  classifyExecutionAuthFailure,
  markSharedOAuthGrantInvalidForProvider,
} from './sharedOAuthReauthMarker';

let registered = false;

export const ensurePlatformAiRuntimeRegistered = (): void => {
  if (registered) return;
  const implementation: PlatformAiRuntimeImplementation = {
    // Deferred on purpose: `globalConfig` runs `ensurePlatformAiRuntimeRegistered()` at module
    // top level, and it sits on the import cycle runtimeAdapter → credentialAdapter →
    // modules/ModelRuntime → globalConfig → this file. When `runtimeAdapter` is the entry
    // (the managed-resource readiness probe imports it lazily on the request path), reading
    // the binding here during evaluation is a TDZ ReferenceError; a closure reads it at call time.
    createModelAllowlistHooks: (allowedModels) => createAiCatalogModelAllowlistHooks(allowedModels),
    isEnabled: () => parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AI,
    isTakeoverActive: (db) => isPlatformAiTakeoverActive(db),
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
      // `resolveAiCatalogRuntimeState` returns the (empty) upstream state whenever the
      // platform has not taken over, so this is `null` for every provider then.
      const managed = state.enabledAiProviders.some((provider) => provider.id === providerKey);
      if (!managed) return null;
      return state.enabledAiModels.filter((model) => model.providerId === providerKey);
    },
    /**
     * The runtime half of the shared-account reauth marker: a chat rejected as unauthenticated
     * is the ONLY signal that a still-unexpired stored access token has stopped being accepted.
     * Transient rejections (Cloudflare, rate limit, upstream 5xx) are classified out here, and
     * the write itself is debounced + best-effort, so a broken shared account costs one write
     * per debounce window rather than one per failing member request.
     */
    reportExecutionAuthFailure: async ({ credentialDigest, db, errorType, providerKey }) => {
      const reason = classifyExecutionAuthFailure(errorType);
      if (!reason) return;
      const flags = parseEnterpriseFeatureFlags(process.env);
      const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
      if (!secrets) return;
      await markSharedOAuthGrantInvalidForProvider({
        // Pins the observation to the credential the execution actually used.
        credentialDigest,
        db,
        providerKey,
        reason,
        secrets: new AiCatalogSecretManager(secrets),
      });
    },
    resolveExecutionConfig: async (db, providerKey) => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      // No published 平台托管 ⇒ the platform owns nothing on the user's behalf. Reported as
      // NOT_FOUND (never a platform error) so `initModelRuntimeFromDB` falls back to the
      // user's own runtime — the same signal an unmanaged/disabled provider produces, so
      // ModelRuntime needs no knowledge of enforcement.
      if (!(await isPlatformAiTakeoverActive(db, flags))) throw new AiCatalogNotFoundError();
      const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
      if (!secrets) throw new Error('PLATFORM_SECRET_REQUIRED');
      return new AiCatalogExecutionResolver(db, secrets).resolveProviderExecutionConfig(
        providerKey,
      );
    },
    // Deliberately NOT gated: a pinned platform-agent operation must keep running on the exact
    // provider revision it started on, and is terminal by design (no BYOK fallback).
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
    wrapModelRuntime: (runtime, ctx) =>
      isBootModuleEnabled('moderation') ? wrapModelRuntimeWithModeration(runtime, ctx) : runtime,
  };
  registerPlatformAiRuntime(implementation);
  registered = true;
};
