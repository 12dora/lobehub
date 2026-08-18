import debug from 'debug';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { PlatformSecretService } from '../../security/secret';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import { isModuleEnabled } from '../moduleSettings';

const log = debug('lobe-server:ai-catalog-readiness');

let registered = false;

export interface AiCatalogRuntimeReadiness {
  aiModels: boolean;
  aiProviders: boolean;
}

const UNREADY_AI_CATALOG: AiCatalogRuntimeReadiness = {
  aiModels: false,
  aiProviders: false,
};

const describeExecutionFailure = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

export const resolveAiCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    flags?: EnterpriseFeatureFlags;
    secretService?: PlatformSecretService | null;
  } = {},
): Promise<AiCatalogRuntimeReadiness> => {
  try {
    const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AI) return UNREADY_AI_CATALOG;
    // Hot view: registration always happens (G2); the probe no-ops when the module is off.
    if (!params.flags && !(await isModuleEnabled('managedAi'))) return UNREADY_AI_CATALOG;
    // Lazy: a static import of runtimeAdapter pulled catalogAuthority / model-bank
    // at worker-spec start() and raced a TDZ (ReferenceError) on boot.
    const [{ PlatformSecretService }, adapter] = await Promise.all([
      import('../../security/secret'),
      import('./runtimeAdapter'),
    ]);
    const secrets =
      params.secretService ?? PlatformSecretService.fromEnvOrThrowIfEnterprise(process.env, flags);
    if (!secrets) return UNREADY_AI_CATALOG;
    const db = params.db ?? (await getServerDB());
    const state = await new adapter.AiCatalogRuntimeAdapter(db).resolve({
      flags,
      upstreamState: adapter.getEmptyAiProviderRuntimeState(),
    });
    if (state.enabledAiProviders.length === 0) return UNREADY_AI_CATALOG;

    const resolver = new adapter.AiCatalogExecutionResolver(db, secrets);
    const executableProviderIds = new Set<string>();
    await Promise.all(
      state.enabledAiProviders.map(async (provider) => {
        try {
          // Health probe: never make outbound token calls or wait on refresh leases here —
          // a third-party OAuth blip must not downgrade managed-resource enforcement.
          await resolver.resolveProviderExecutionConfig(provider.id, {
            skipSharedOAuthRefresh: true,
          });
          executableProviderIds.add(provider.id);
        } catch (error) {
          // applyImmediate may publish a provider whose vault cannot decrypt; skip it
          // instead of failing the whole catalog (a sibling provider can still be ready).
          log(
            'skipping provider %s whose execution config failed to resolve (%s)',
            provider.id,
            describeExecutionFailure(error),
          );
        }
      }),
    );

    if (executableProviderIds.size === 0) return UNREADY_AI_CATALOG;

    return {
      aiModels: state.enabledAiModels.some(
        (model) =>
          model.enabled && model.type === 'chat' && executableProviderIds.has(model.providerId),
      ),
      aiProviders: true,
    };
  } catch (error) {
    // Never rethrow: the readiness registry logs the raw rejection. Only the
    // error class is safe to emit (message/stack can carry vault or query context).
    log('probe failed (%s)', describeExecutionFailure(error));
    return UNREADY_AI_CATALOG;
  }
};

/**
 * Collapse concurrent calls into one execution.
 *
 * `aiProviders` and `aiModels` share one catalog evaluation (via this helper)
 * because `resolveManagedResourceReadiness` invokes every registered entry
 * concurrently. Without sharing, every pass would load the published catalog
 * and decrypt provider secrets twice. Deliberately not a TTL cache: the
 * pending promise is dropped as soon as it settles (success or failure), so
 * no result — and in particular no rejection — outlives its pass and
 * admin/publish reads stay fresh.
 */
export const createSingleFlightReadinessProbe = <T>(
  probe: () => Promise<T>,
): (() => Promise<T>) => {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= probe().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
};

/** Registers lazy DB-backed probes; registration itself performs no I/O. */
export const ensureAiCatalogReadinessRegistered = (
  probe: () => Promise<AiCatalogRuntimeReadiness> = () => resolveAiCatalogRuntimeReadiness(),
): void => {
  if (registered) return;
  registered = true;
  // Swallow injected-probe rejections (and sync throws) *before* single-flight so a
  // rejecting test/seam never reaches the registry's raw `console.error({ error })`.
  const singleFlight = createSingleFlightReadinessProbe(async () => {
    try {
      return await probe();
    } catch (error) {
      log('probe failed (%s)', describeExecutionFailure(error));
      return UNREADY_AI_CATALOG;
    }
  });
  registerManagedResourceReadiness('aiProviders', async () => (await singleFlight()).aiProviders);
  registerManagedResourceReadiness('aiModels', async () => (await singleFlight()).aiModels);
};

export const resetAiCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
