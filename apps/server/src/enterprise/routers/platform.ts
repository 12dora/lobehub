import { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { RbacModel } from '@/database/models/rbac';
import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { parseEasyauthConfig } from '../config/easyauth';
import { publishedAiCatalogSchema } from '../contracts/aiCatalog';
import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { resolveAccessStatus } from '../guards/accessGrant';
import { AiCatalogReadService, getEmptyPublishedAiCatalog } from '../services/aiCatalog';
import { ensureConnectorRuntimeAuditWorkerStarted } from '../services/connectorCatalog/runtimeAuditWorker';
import { publishConnectorRuntimeCapabilityState } from '../services/connectorCatalog/runtimeEffectiveState';
import { buildEasyauthDescriptor } from '../services/easyauthManifest';
import { resolvePublishedManagedResourcePolicies } from '../services/managedResourceCapabilities';
import { buildPlatformCapabilities } from '../services/platformCapabilities';
import { buildPlatformPublicSnapshot } from '../services/platformPublicSnapshot';
import { ensureSkillCatalogReadinessRegistered } from '../services/skillCatalog';
import { platformAgentsRouter } from './platformAgents';
import { platformSkillsRouter } from './platformSkills';

ensureSkillCatalogReadinessRegistered();

ensureConnectorRuntimeAuditWorkerStarted();

/**
 * Platform router (M00 read-only + M02 access status / descriptor).
 *
 * - getCapabilities: **authenticated** — adminAccess from Global RBAC when flag on.
 * - getPublicSnapshot: anonymous-safe branding / login flags.
 * - getAccessStatus: authenticated aihub.access status + permission request URL.
 * - getEasyauthDescriptor: public EasyAuth app descriptor (manifest).
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

  getPublicSnapshot: publicProcedure.query(() => {
    const flags = parseEnterpriseFeatureFlags(process.env);

    return buildPlatformPublicSnapshot({
      flags,
      workAccountEnabled: false,
    });
  }),

  /**
   * aihub.access status for the current principal (login → "request access" page).
   */
  getAccessStatus: authedProcedure.use(serverDatabase).query(async ({ ctx }) => {
    return resolveAccessStatus({
      db: ctx.serverDB,
      userId: ctx.userId!,
    });
  }),

  /**
   * EasyAuth application descriptor (also served at GET /.well-known/easyauth-app.json).
   */
  getEasyauthDescriptor: publicProcedure
    .input(z.object({ schemaVersion: z.number().int().min(1).optional() }).optional())
    .query(({ input }) => {
      const config = parseEasyauthConfig();
      return buildEasyauthDescriptor({
        schemaVersion: input?.schemaVersion ?? config.manifestSchemaVersion,
      });
    }),
});

export type PlatformRouter = typeof platformRouter;
