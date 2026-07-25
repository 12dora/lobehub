/**
 * One-shot process bootstrap for connector runtime effective-state.
 *
 * Policy publish/finalize remains the authority for transitions. This path only
 * seeds shared state after process start so workers do not stay fail-closed
 * `blocked` until the next admin publish. It is intentionally not invoked from
 * user-facing `platform.getCapabilities` reads (SR-003).
 */
import { getServerDB } from '@/database/core/db-adaptor';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { resolvePublishedManagedResourcePolicies } from '../managedResourceCapabilities';
import { publishConnectorRuntimeCapabilityState } from './runtimeEffectiveState';

let bootstrapStarted = false;

/** Test-only: allow re-arming bootstrap between cases. */
export const __resetConnectorRuntimeCapabilityBootstrapForTests = (): void => {
  bootstrapStarted = false;
};

/**
 * Fire-and-forget DB-backed capability publish once per process.
 * Failures are logged; connector execution remains fail-closed until a later
 * successful publish/finalize.
 */
export const ensureConnectorRuntimeCapabilityStateBootstrapped = (): void => {
  if (bootstrapStarted) return;
  bootstrapStarted = true;

  void (async () => {
    try {
      const flags = parseEnterpriseFeatureFlags(process.env);
      if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return;

      const db = await getServerDB();
      const managed = await resolvePublishedManagedResourcePolicies({ db, flags });
      const connectorPolicy = managed.published.connectors;
      await publishConnectorRuntimeCapabilityState({
        mode:
          !connectorPolicy.managed || connectorPolicy.enforcementMode !== 'enforced'
            ? 'legacy'
            : managed.readiness.connectors
              ? 'enforced'
              : 'blocked',
        revision: managed.revision,
      });
    } catch (error) {
      console.error('[connector-runtime-state] capability bootstrap failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  })();
};
