import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { type EnterpriseFeatureFlags, parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformSecretService } from '../../security/secret';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import {
  AiCatalogExecutionResolver,
  AiCatalogRuntimeAdapter,
  getEmptyAiProviderRuntimeState,
} from './runtimeAdapter';

let registered = false;

export const resolveAiCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    flags?: EnterpriseFeatureFlags;
    secretService?: PlatformSecretService | null;
  } = {},
): Promise<boolean> => {
  const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_AI) return false;
  const secrets =
    params.secretService ?? PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
  if (!secrets) return false;
  const db = params.db ?? (await getServerDB());
  const state = await new AiCatalogRuntimeAdapter(db).resolve({
    flags,
    upstreamState: getEmptyAiProviderRuntimeState(),
  });
  const hasExecutableChatModel = state.enabledAiModels.some(
    (model) => model.enabled && model.type === 'chat',
  );
  if (!hasExecutableChatModel) return false;
  const resolver = new AiCatalogExecutionResolver(db, secrets);
  await Promise.all(
    state.enabledAiProviders.map((provider) =>
      resolver.resolveProviderExecutionConfig(provider.id),
    ),
  );
  return true;
};

/** Registers lazy DB-backed probes; registration itself performs no I/O. */
export const ensureAiCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  const probe = () => resolveAiCatalogRuntimeReadiness();
  registerManagedResourceReadiness('aiProviders', probe);
  registerManagedResourceReadiness('aiModels', probe);
};

export const resetAiCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
