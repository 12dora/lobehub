/**
 * Idempotent registration of managed-resource readiness probes.
 *
 * Instrumentation (`startEnterpriseWorkers`) registers these into the process
 * registry. Next.js standalone evaluates `instrumentation.ts` and route
 * handlers as two module graphs, so the request path also lazy-calls this
 * from `resolveManagedResourceReadiness` when any kind is missing.
 *
 * Never import `runtimeReadiness` statically from `managedResourceReadiness`
 * (those files import the registry). Never register at module import time.
 *
 * The pending promise + done flag live on `globalThis` (sibling of the probe
 * registry) so two module copies share one in-flight registration.
 */
import { getManagedResourceReadinessRegisterState } from '../services/managedResourceReadiness';

export const ensureManagedResourceReadinessProbes = (): Promise<void> => {
  const state = getManagedResourceReadinessRegisterState();
  if (state.done) return Promise.resolve();
  state.inflight ??= (async () => {
    try {
      const [
        { ensureAiCatalogReadinessRegistered },
        { ensureConnectorCatalogReadinessRegistered },
        { ensureSkillCatalogReadinessRegistered },
        { ensureAgentCatalogReadinessRegistered },
      ] = await Promise.all([
        import('../services/aiCatalog/runtimeReadiness'),
        import('../services/connectorCatalog/runtimeReadiness'),
        import('../services/skillCatalog/runtimeReadiness'),
        import('../services/agentCatalog/runtimeReadiness'),
      ]);
      ensureAiCatalogReadinessRegistered();
      ensureConnectorCatalogReadinessRegistered();
      ensureSkillCatalogReadinessRegistered();
      ensureAgentCatalogReadinessRegistered();
      state.done = true;
    } catch (error) {
      state.inflight = null;
      throw error;
    }
  })();
  return state.inflight;
};

/** Test helper — drop the process-once latch so a later resolve can re-ensure. */
export const resetManagedResourceReadinessProbesForTest = (): void => {
  const state = getManagedResourceReadinessRegisterState();
  state.done = false;
  state.inflight = null;
};
