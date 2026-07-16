import { getServerDB } from '@/database/core/db-adaptor';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformSecretService } from '../../security/secret';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import {
  AiCatalogExecutionResolver,
  AiCatalogRuntimeAdapter,
  getEmptyAiProviderRuntimeState,
} from './runtimeAdapter';

let registered = false;

/** Registers lazy DB-backed probes; registration itself performs no I/O. */
export const ensureAiCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  const probe = async () => {
    const flags = parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AI) return false;
    const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
    if (!secrets) return false;
    const db = await getServerDB();
    const state = await new AiCatalogRuntimeAdapter(db).resolve({
      flags,
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    if (state.enabledAiProviders.length === 0 || state.enabledAiModels.length === 0) return false;
    const resolver = new AiCatalogExecutionResolver(db, secrets);
    await Promise.all(
      state.enabledAiProviders.map((provider) =>
        resolver.resolveProviderExecutionConfig(provider.id),
      ),
    );
    return true;
  };
  registerManagedResourceReadiness('aiProviders', probe);
  registerManagedResourceReadiness('aiModels', probe);
};

export const resetAiCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
