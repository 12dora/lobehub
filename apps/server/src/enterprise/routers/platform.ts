import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformSidebarLayoutModel } from '@/database/models/platform';
import { RbacModel } from '@/database/models/rbac';
import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { platformPublicSnapshotSchema } from '@/types/platform/publicSnapshot';
import { sidebarLayoutPolicySchema } from '@/types/platform/sidebarLayout';

import { publishedAiCatalogSchema } from '../contracts/aiCatalog';
import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { resolveAccessStatus } from '../guards/accessGrant';
import { ensurePlatformAgentRolloutWorkerStarted } from '../jobs/agentRollout';
import { ensurePlatformAuditExportWorkerStarted } from '../jobs/auditExport';
import { ensurePlatformAuditRetentionWorkerStarted } from '../jobs/auditRetention';
import { ensureIdentityProviderTestAttemptCleanupStarted } from '../jobs/identityProviderTestAttemptCleanup';
import { ensurePlatformSecretRewrapWorkerStarted } from '../jobs/secretRewrap';
import { AiCatalogReadService, getEmptyPublishedAiCatalog } from '../services/aiCatalog';
import { resolvePlatformPublicSnapshot } from '../services/branding';
import { ensureConnectorRuntimeAuditWorkerStarted } from '../services/connectorCatalog/runtimeAuditWorker';
import { publishConnectorRuntimeCapabilityState } from '../services/connectorCatalog/runtimeEffectiveState';
import { resolvePublishedManagedResourcePolicies } from '../services/managedResourceCapabilities';
import { buildPlatformCapabilities } from '../services/platformCapabilities';
import { ensureSkillCatalogReadinessRegistered } from '../services/skillCatalog';
import { platformAgentsRouter } from './platformAgents';
import { platformSkillsRouter } from './platformSkills';

ensureSkillCatalogReadinessRegistered();

ensureConnectorRuntimeAuditWorkerStarted();

ensurePlatformAgentRolloutWorkerStarted();

ensureIdentityProviderTestAttemptCleanupStarted();

ensurePlatformSecretRewrapWorkerStarted();

ensurePlatformAuditExportWorkerStarted();

ensurePlatformAuditRetentionWorkerStarted();

/**
 * Platform router (M00 read-only + access status).
 *
 * - getCapabilities: **authenticated** — adminAccess from Global RBAC when flag on.
 * - getPublicSnapshot: anonymous-safe branding / login flags.
 * - getAccessStatus: authenticated access status (always granted after EasyAuth removal).
 */
export const platformRouter = router({
  agents: platformAgentsRouter,
  aiCatalog: router({
    getPublished: authedProcedure
      .use(serverDatabase)
      .output(publishedAiCatalogSchema)
      .query(async ({ ctx }) => {
        const flags = parseEnterpriseFeatureFlags(process.env);
        if (!flags.ENABLE_PLATFORM_MANAGED_AI) return getEmptyPublishedAiCatalog();
        return new AiCatalogReadService(ctx.serverDB).getPublished();
      }),
  }),

  skills: platformSkillsRouter,

  getCapabilities: authedProcedure.use(serverDatabase).query(async ({ ctx }) => {
    const flags = parseEnterpriseFeatureFlags(process.env);

    let adminAccess = false;
    if (flags.ENABLE_PLATFORM_ADMIN && ctx.userId) {
      const rbac = new RbacModel(ctx.serverDB, ctx.userId);
      adminAccess = await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.ADMIN_ACCESS, ctx.userId);
    }

    const managed = await resolvePublishedManagedResourcePolicies({
      db: ctx.serverDB,
      flags,
    });
    const connectorPolicy = managed.published.connectors;
    if (flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
      await publishConnectorRuntimeCapabilityState({
        mode:
          !connectorPolicy.managed || connectorPolicy.enforcementMode !== 'enforced'
            ? 'legacy'
            : managed.readiness.connectors
              ? 'enforced'
              : 'blocked',
        revision: managed.revision,
      });
    }

    return buildPlatformCapabilities({
      adminAccess,
      flags,
      managedResources: managed.publicCapabilities,
      revisions: { configRevision: String(managed.revision) },
    });
  }),

  getPublicSnapshot: publicProcedure
    .output(platformPublicSnapshotSchema)
    .query(async () =>
      resolvePlatformPublicSnapshot({ flags: parseEnterpriseFeatureFlags(process.env) }),
    ),

  /**
   * Home-sidebar layout policy for the current user (M15).
   * When the platform manages the sidebar, `managed` is true and (if configured) `layout`
   * carries the layout to apply; the client then hides its sidebar-customization controls.
   */
  getSidebarLayout: authedProcedure
    .use(serverDatabase)
    .output(sidebarLayoutPolicySchema)
    .query(async ({ ctx }) => {
      const policy = await new PlatformSidebarLayoutModel(ctx.serverDB).get();
      const managed = policy.mode === 'platform';
      return { layout: managed ? policy.layout : null, managed };
    }),

  /**
   * Access status for the current principal (always granted after EasyAuth removal).
   */
  getAccessStatus: authedProcedure.use(serverDatabase).query(async ({ ctx }) => {
    return resolveAccessStatus({
      db: ctx.serverDB,
      userId: ctx.userId!,
    });
  }),
});

export type PlatformRouter = typeof platformRouter;
