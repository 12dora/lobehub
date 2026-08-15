import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
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
      // Health probe: never make outbound token calls or wait on refresh leases here —
      // a third-party OAuth blip must not downgrade managed-resource enforcement.
      resolver.resolveProviderExecutionConfig(provider.id, { skipSharedOAuthRefresh: true }),
    ),
  );
  return true;
};

/**
 * Collapse concurrent calls into one execution.
 *
 * `aiProviders` and `aiModels` are backed by the SAME probe, and
 * `resolveManagedResourceReadiness` invokes every registered entry concurrently — so without
 * this every readiness pass would load the published catalog and decrypt every provider secret
 * TWICE. Deliberately not a TTL cache: the pending promise is dropped as soon as it settles
 * (success or failure), so no result — and in particular no rejection — outlives its pass and
 * admin/publish reads stay fresh.
 */
export const createSingleFlightReadinessProbe = (
  probe: () => Promise<boolean>,
): (() => Promise<boolean>) => {
  let inFlight: Promise<boolean> | null = null;
  return () => {
    inFlight ??= probe().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
};

/** Registers lazy DB-backed probes; registration itself performs no I/O. */
export const ensureAiCatalogReadinessRegistered = (
  probe: () => Promise<boolean> = () => resolveAiCatalogRuntimeReadiness(),
): void => {
  if (registered) return;
  registered = true;
  // One shared instance for both resources — see createSingleFlightReadinessProbe.
  const singleFlight = createSingleFlightReadinessProbe(probe);
  registerManagedResourceReadiness('aiProviders', singleFlight);
  registerManagedResourceReadiness('aiModels', singleFlight);
};

export const resetAiCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
