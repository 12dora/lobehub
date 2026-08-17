/**
 * Boot-time worker registry.
 *
 * Former top-level side effects of `routers/platform.ts` (and the three
 * readiness registrations in `routers/admin.ts`) live here so a disabled
 * module never starts its poller / gateway / subprocess. `startEnterpriseWorkers`
 * is awaited from `src/instrumentation.ts` after `initBootModules()`.
 *
 * Each `start` is a dynamic import so a skipped module does not pull its
 * service graph into the boot path (GatewayService's discord/telegram/slack
 * tree is the expensive example).
 */
import type { PlatformModuleId } from '@/const/platform/modules';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { isBootModuleEnabled } from '../services/moduleSettings';

export interface WorkerSpec {
  moduleId?: PlatformModuleId;
  name: string;
  start: () => Promise<void> | void;
}

const startGatewayService = async (): Promise<void> => {
  const isDev = process.env.NODE_ENV !== 'production';
  if (
    !process.env.DATABASE_URL ||
    process.env.VERCEL_ENV ||
    (isDev && process.env.ENABLE_BOT_IN_DEV !== '1')
  ) {
    return;
  }
  const { GatewayService } = await import('@/server/services/gateway');
  const service = new GatewayService();
  service.ensureRunning().catch((error) => {
    console.error('[Instrumentation] Failed to auto-start GatewayManager:', error);
  });
};

/**
 * Module-owned names MUST equal `PLATFORM_MODULES[*].workers` entries.
 * Specs without `moduleId` are core and always start (subject to their own
 * runtime / Vault predicates).
 */
export const ENTERPRISE_WORKER_SPECS: readonly WorkerSpec[] = [
  {
    name: 'warnIfPlatformMasterKeyMissing',
    start: async () => {
      const { warnIfPlatformMasterKeyMissing } = await import('../security/secret');
      warnIfPlatformMasterKeyMissing(process.env, parseEnterpriseFeatureFlags(process.env));
    },
  },
  {
    name: 'connectorRuntimeCapabilityState',
    start: async () => {
      const { ensureConnectorRuntimeCapabilityStateBootstrapped } =
        await import('../services/connectorCatalog/runtimeEffectiveStateBootstrap');
      // Process-once latch lives inside the callee (SR-003: never from user reads).
      ensureConnectorRuntimeCapabilityStateBootstrapped();
    },
  },
  // HOT-kind (and zero-I/O connector) readiness: always register. The probe
  // itself consults the hot view so a boot-disabled module can be enabled
  // without a restart. Do not set moduleId — that would skip registration.
  {
    name: 'aiCatalogReadiness',
    start: async () => {
      const { ensureAiCatalogReadinessRegistered } =
        await import('../services/aiCatalog/runtimeReadiness');
      ensureAiCatalogReadinessRegistered();
    },
  },
  {
    name: 'connectorCatalogReadiness',
    start: async () => {
      const { ensureConnectorCatalogReadinessRegistered } =
        await import('../services/connectorCatalog/runtimeReadiness');
      ensureConnectorCatalogReadinessRegistered();
    },
  },
  {
    name: 'skillCatalogReadiness',
    start: async () => {
      const { ensureSkillCatalogReadinessRegistered } =
        await import('../services/skillCatalog/runtimeReadiness');
      ensureSkillCatalogReadinessRegistered();
    },
  },
  {
    moduleId: 'audit',
    name: 'auditExport',
    start: async () => {
      const { ensurePlatformAuditExportWorkerStarted } = await import('../jobs/auditExport');
      ensurePlatformAuditExportWorkerStarted();
    },
  },
  {
    moduleId: 'audit',
    name: 'auditRetention',
    start: async () => {
      const { ensurePlatformAuditRetentionWorkerStarted } = await import('../jobs/auditRetention');
      ensurePlatformAuditRetentionWorkerStarted();
    },
  },
  {
    moduleId: 'managedAgents',
    name: 'agentRollout',
    start: async () => {
      const { ensurePlatformAgentRolloutWorkerStarted } = await import('../jobs/agentRollout');
      ensurePlatformAgentRolloutWorkerStarted();
    },
  },
  {
    moduleId: 'managedConnectors',
    name: 'connectorRuntimeAudit',
    start: async () => {
      const { ensureConnectorRuntimeAuditWorkerStarted } =
        await import('../services/connectorCatalog/runtimeAuditWorker');
      ensureConnectorRuntimeAuditWorkerStarted();
    },
  },
  {
    moduleId: 'managedConnectors',
    name: 'connectorSecretCleanup',
    start: async () => {
      const { ensureConnectorSecretCleanupWorkerStarted } =
        await import('../services/connectorCatalog/secretCleanupWorker');
      ensureConnectorSecretCleanupWorkerStarted();
    },
  },
  {
    moduleId: 'managedConnectors',
    name: 'sharedOAuthKeepalive',
    start: async () => {
      const { ensureSharedOAuthKeepaliveWorkerStarted } =
        await import('../jobs/sharedOAuthKeepalive');
      ensureSharedOAuthKeepaliveWorkerStarted();
    },
  },
  {
    moduleId: 'branding',
    name: 'brandingAssetCleanup',
    start: async () => {
      const { ensureBrandingAssetCleanupWorkerStarted } =
        await import('../jobs/brandingAssetCleanup');
      ensureBrandingAssetCleanupWorkerStarted();
    },
  },
  {
    moduleId: 'databaseIdp',
    name: 'identityProviderTestAttemptCleanup',
    start: async () => {
      const { ensureIdentityProviderTestAttemptCleanupStarted } =
        await import('../jobs/identityProviderTestAttemptCleanup');
      ensureIdentityProviderTestAttemptCleanupStarted();
    },
  },
  {
    moduleId: 'databaseIdp',
    name: 'platformInstanceRegistryCleanup',
    start: async () => {
      const { ensurePlatformInstanceRegistryCleanupStarted } =
        await import('../jobs/platformInstanceRegistryCleanup');
      ensurePlatformInstanceRegistryCleanupStarted();
    },
  },
  {
    // Core: no moduleId. Only meaningful when the key provider is Vault —
    // otherwise the 2s poller is a pure idle-CPU leak.
    name: 'secretRewrap',
    start: async () => {
      const { parsePlatformKeyProviderName } = await import('../security/secret');
      try {
        if (parsePlatformKeyProviderName(process.env) !== 'vault') return;
      } catch {
        return;
      }
      const { ensurePlatformSecretRewrapWorkerStarted } = await import('../jobs/secretRewrap');
      ensurePlatformSecretRewrapWorkerStarted();
    },
  },
  {
    moduleId: 'networkProxy',
    name: 'networkProxyEngineSupervisor',
    start: async () => {
      // Bind egress at boot so the first request sees the ALS hook. G4 owns
      // egress/scope; we only load it when this module is on.
      const { bindNetworkProxyEgressIfEnabled } =
        await import('../services/networkProxy/engine/bindEgress');
      await bindNetworkProxyEgressIfEnabled();
      const { ensureNetworkProxyEngineSupervisorStarted } =
        await import('../services/networkProxy/engine/runtime');
      ensureNetworkProxyEngineSupervisorStarted();
    },
  },
  {
    moduleId: 'bots',
    name: 'gatewayService',
    start: startGatewayService,
  },
];

let started = false;

/** Test helper — drop the process-once latch. */
export const resetEnterpriseWorkersBootstrapForTest = (): void => {
  started = false;
};

/**
 * Start every registered spec. A disabled module logs one skip line and does
 * not import the worker. One spec's error never stops the rest.
 *
 * The default (full) list is process-once. Passing an explicit `specs` array
 * (tests) always runs.
 */
export const startEnterpriseWorkers = async (
  specs: readonly WorkerSpec[] = ENTERPRISE_WORKER_SPECS,
): Promise<void> => {
  const isDefaultList = specs === ENTERPRISE_WORKER_SPECS;
  if (isDefaultList) {
    if (started) return;
    started = true;
  }

  for (const spec of specs) {
    if (spec.moduleId && !isBootModuleEnabled(spec.moduleId)) {
      console.info(`[modules] worker ${spec.name} skipped: module ${spec.moduleId} disabled`);
      continue;
    }
    try {
      await spec.start();
    } catch (error) {
      console.error(`[modules] worker ${spec.name} failed to start`, {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
};
