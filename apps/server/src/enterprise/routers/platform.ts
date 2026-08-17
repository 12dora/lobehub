import { TASK_TEMPLATE_RECOMMEND_MAX_COUNT } from '@lobechat/const';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformSidebarLayoutModel, PlatformTaskTemplateModel } from '@/database/models/platform';
import { RbacModel } from '@/database/models/rbac';
import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { platformPublicSnapshotSchema } from '@/types/platform/publicSnapshot';
import {
  DEFAULT_SIDEBAR_LAYOUT_POLICY,
  sidebarLayoutPolicySchema,
} from '@/types/platform/sidebarLayout';

import {
  EMPTY_PLATFORM_TASK_TEMPLATE_LIST,
  platformTaskTemplateListOutputSchema,
} from '../contracts/adminTaskTemplates';
import { publishedAiCatalogSchema } from '../contracts/aiCatalog';
import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { resolveAccessStatus } from '../guards/accessGrant';
import {
  AiCatalogReadService,
  getEmptyPublishedAiCatalog,
  isPlatformAiTakeoverActive,
} from '../services/aiCatalog';
import { resolvePlatformPublicSnapshot } from '../services/branding';
import {
  resolveManagedResourceReadinessCached,
  resolvePublishedManagedResourcePolicies,
} from '../services/managedResourceCapabilities';
import { getModuleSettingsSnapshot, isModuleEnabled } from '../services/moduleSettings';
import { buildPlatformCapabilities } from '../services/platformCapabilities';
import { isRenderableTaskTemplate, toPlatformTaskTemplate } from './admin/taskTemplatesSupport';
import { withActiveUserWhenManaged } from './managedActiveUser';
import { platformAgentsRouter } from './platformAgents';
import { platformSkillsRouter } from './platformSkills';

/**
 * Platform router (M00 read-only + access status).
 *
 * - getCapabilities: **authenticated** — adminAccess from Global RBAC when flag on.
 * - getPublicSnapshot: anonymous-safe branding / login flags.
 * - getAccessStatus: authenticated access status (always granted for authenticated users).
 */
export const platformRouter = router({
  agents: platformAgentsRouter,
  aiCatalog: router({
    getPublished: authedProcedure
      .use(serverDatabase)
      .use(withActiveUserWhenManaged('ENABLE_PLATFORM_MANAGED_AI'))
      .output(publishedAiCatalogSchema)
      .query(async ({ ctx }) => {
        // Stable-empty contract when the feature/module is off (client reads empty as "not managed").
        const flags = parseEnterpriseFeatureFlags(process.env);
        if (!flags.ENABLE_PLATFORM_MANAGED_AI || !(await isModuleEnabled('managedAi')))
          return getEmptyPublishedAiCatalog();
        return new AiCatalogReadService(ctx.serverDB).getPublished();
      }),
  }),

  skills: platformSkillsRouter,

  taskTemplates: router({
    /**
     * Platform-managed 任务模板 for the current user (home 为你推荐 + agent-task empty state).
     *
     * Emptiness is meaningful: `managed: false` (flag off, or zero rows in the table) tells the
     * client to keep using the remote market recommendations. Once the table holds any row the
     * platform list is authoritative and only enabled rows are returned.
     */
    list: authedProcedure
      .use(serverDatabase)
      .output(platformTaskTemplateListOutputSchema)
      .query(async ({ ctx }) => {
        const flags = parseEnterpriseFeatureFlags(process.env);
        if (!flags.ENABLE_PLATFORM_ADMIN || !(await isModuleEnabled('taskTemplates')))
          return { ...EMPTY_PLATFORM_TASK_TEMPLATE_LIST };

        const model = new PlatformTaskTemplateModel(ctx.serverDB);
        const total = await model.count();
        if (total === 0) return { ...EMPTY_PLATFORM_TASK_TEMPLATE_LIST };

        // Both consumers render at most TASK_TEMPLATE_RECOMMEND_MAX_COUNT cards; cap server-side
        // so an unbounded catalog can never become an unbounded per-user response.
        const rows = await model.listEnabled(TASK_TEMPLATE_RECOMMEND_MAX_COUNT);
        return {
          managed: true,
          // A row referencing a since-retired connector cannot render; quarantine it here (it
          // stays visible in the admin console) rather than failing the whole managed catalog.
          templates: rows
            .filter((row) => isRenderableTaskTemplate(row))
            .map((row) => toPlatformTaskTemplate(row)),
        };
      }),
  }),

  /**
   * Read-only capability DTO for client bootstrap.
   * Connector runtime effective-state is published on policy finalize and
   * process bootstrap — never mutated here (avoids Redis write amplification).
   */
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
      // Every mounted client polls this endpoint; the AI readiness probe decrypts every
      // published provider secret. Use the short-lived shared snapshot here — admin surfaces
      // and the publish guard keep resolving readiness fresh.
      readiness: resolveManagedResourceReadinessCached,
    });

    const modules = (await getModuleSettingsSnapshot()).effective;

    return buildPlatformCapabilities({
      adminAccess,
      // Explicit runtime-takeover signal: `managedResources.aiProviders` is also true for
      // `ui-only`, where the UI is blocked but the runtime is NOT platform-governed.
      aiTakeover: await isPlatformAiTakeoverActive(ctx.serverDB, flags),
      flags,
      managedResources: managed.publicCapabilities,
      modules,
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
   *
   * When ENABLE_PLATFORM_ADMIN is off, always return the default (unmanaged) policy so a
   * stale platform-mode row cannot alter user-visible behavior after the flag is closed.
   */
  getSidebarLayout: authedProcedure
    .use(serverDatabase)
    .output(sidebarLayoutPolicySchema)
    .query(async ({ ctx }) => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      if (!flags.ENABLE_PLATFORM_ADMIN) {
        return { ...DEFAULT_SIDEBAR_LAYOUT_POLICY };
      }
      const policy = await new PlatformSidebarLayoutModel(ctx.serverDB).get();
      const managed = policy.mode === 'platform';
      return { layout: managed ? policy.layout : null, managed };
    }),

  /**
   * Access status for the current principal (always granted for authenticated users).
   */
  getAccessStatus: authedProcedure.use(serverDatabase).query(async ({ ctx }) => {
    return resolveAccessStatus({
      db: ctx.serverDB,
      userId: ctx.userId!,
    });
  }),
});

export type PlatformRouter = typeof platformRouter;
