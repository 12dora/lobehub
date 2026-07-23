import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { EasyauthGrantSnapshotModel } from '@/database/models/platform/easyauthGrantSnapshot';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { parseEasyauthConfig, redactEasyauthConfig } from '../config/easyauth';
import { adminEasyauthGetStatusOutputSchema } from '../contracts/adminEasyauth';
import {
  adminUsersReplaceGlobalRolesInputSchema,
  adminUsersReplaceGlobalRolesOutputSchema,
} from '../contracts/adminUsers';
import { withActiveUser } from '../guards/activeUser';
import { withAdminMutationRateLimit } from '../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../guards/enterpriseErrors';
import { withAnyPlatformPermission, withPlatformPermission } from '../guards/platformPermission';
import { assertRecentReauth } from '../guards/reauth';
import { AdminUserNotFoundError, AdminUserService } from '../services/adminUserService';
import { ensureAiCatalogReadinessRegistered } from '../services/aiCatalog';
import { ensureConnectorCatalogReadinessRegistered } from '../services/connectorCatalog/runtimeReadiness';
import { EasyauthSyncService, normalizeEasyauthSyncReason } from '../services/easyauthSync';
import { PlatformAuditService } from '../services/platformAudit';
import { LastSuperAdminError, PlatformRbacService } from '../services/platformRbac';
import { ensureSkillCatalogReadinessRegistered } from '../services/skillCatalog';
import { adminAgentsRouter } from './admin/agents';
import { adminAiModelsRouter, adminAiProvidersRouter } from './admin/aiCatalog';
import { adminAuditRouter } from './admin/audit';
import { adminAuthSettingsRouter } from './admin/authSettings';
import { adminBrandingRouter } from './admin/branding';
import { adminConnectorsRouter } from './admin/connectors';
import { adminCredsRouter } from './admin/creds';
import { adminIdentityProvidersRouter } from './admin/identityProviders';
import { adminManagedResourcesRouter } from './admin/managedResources';
import { adminSecurityRouter } from './admin/security';
import { adminSettingsRouter } from './admin/settings';
import { adminSidebarLayoutRouter } from './admin/sidebarLayout';
import { adminSkillsRouter } from './admin/skills';
import { adminStatsRouter } from './admin/stats';
import { adminSystemRouter } from './admin/system';
import { adminUsersRouter } from './admin/users';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

ensureAiCatalogReadinessRegistered();
ensureConnectorCatalogReadinessRegistered();
ensureSkillCatalogReadinessRegistered();

const EASYAUTH_INVALID_REASON_AUDIT_REASON = 'easyauth_sync_invalid_reason';

const safeEasyauthReauthReason = (reason: string): string => {
  try {
    return normalizeEasyauthSyncReason(reason);
  } catch {
    return EASYAUTH_INVALID_REASON_AUDIT_REASON;
  }
};

const assertEasyauthDangerousReauth = async (params: {
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
  targetId: string;
}) => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: 'admin.easyauth.triggerSync',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: params.reason,
        result: 'denied',
        targetId: params.targetId,
        targetType: 'user',
      });
    } catch (auditError) {
      console.error('[admin.easyauth] reauth denied audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

export const adminAuthRouter = router({
  /**
   * Permissions for admin shell / menu.
   * Authenticated users only — empty permissions when no platform roles.
   */
  getMyAccess: adminBase.query(async ({ ctx }) => {
    const service = new PlatformRbacService(ctx.serverDB);
    const permissions = await service.getUserGlobalPermissions(ctx.userId!);
    const roles = await service.listUserGlobalRoles(ctx.userId!);
    return {
      /**
       * Server-authenticated method for admin reauth routing (never invent client-side).
       * oidc → Better Auth OAuth2 popup with prompt=login; better-auth → credential/session.
       */
      authMethod: ctx.authMethod ?? null,
      hasAdminAccess: permissions.includes(PLATFORM_PERMISSIONS.ADMIN_ACCESS),
      permissions,
      roles: roles.map((r) => ({
        displayName: r.displayName,
        name: r.name,
      })),
    };
  }),
});

export const adminRolesRouter = router({
  listSystemRoles: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.ROLE_READ))
    .query(async ({ ctx }) => {
      const service = new PlatformRbacService(ctx.serverDB);
      return service.listSystemRoles();
    }),

  listUserAssignments: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.ROLE_READ))
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new PlatformRbacService(ctx.serverDB);
      const roles = await service.listUserGlobalRoles(input.userId);
      return {
        roles: roles.map((r) => ({
          displayName: r.displayName,
          id: r.id,
          name: r.name,
        })),
        userId: input.userId,
      };
    }),

  /**
   * Compatibility alias → M04 AdminUserService.replaceGlobalRoles.
   * Same fixed roles, reauth, audit, super rules, last-super as admin.users.replaceGlobalRoles.
   */
  replaceUserGlobalRoles: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.ROLE_UPDATE))
    .input(adminUsersReplaceGlobalRolesInputSchema)
    .output(adminUsersReplaceGlobalRolesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        assertRecentReauth({
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
        });
      } catch (error) {
        const service = new AdminUserService(ctx.serverDB);
        await service.recordReauthDenied({
          action: 'admin.roles.replaceUserGlobalRoles',
          actorUserId: ctx.userId!,
          reason: input.reason,
          targetId: input.userId,
        });
        throw error;
      }

      const service = new AdminUserService(ctx.serverDB);
      try {
        return await service.replaceGlobalRoles({
          actorUserId: ctx.userId!,
          input,
        });
      } catch (error) {
        if (error instanceof LastSuperAdminError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN,
            httpCode: 'PRECONDITION_FAILED',
          });
        }
        if (error instanceof AdminUserNotFoundError) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
            httpCode: 'NOT_FOUND',
          });
        }
        if (
          error instanceof Error &&
          error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED
        ) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
            httpCode: 'FORBIDDEN',
          });
        }
        if (
          error instanceof Error &&
          error.message === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
        ) {
          throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
            httpCode: 'BAD_REQUEST',
          });
        }
        throw error;
      }
    }),
});

export const adminEasyauthRouter = router({
  /**
   * Redacted EasyAuth deployment + grant-snapshot aggregate for identity admin surfaces.
   * Read-only; IDENTITY_READ; never returns token material.
   */
  getStatus: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .output(adminEasyauthGetStatusOutputSchema)
    .query(async ({ ctx }) => {
      const config = parseEasyauthConfig();
      const redacted = redactEasyauthConfig(config);
      const aggregate = await new EasyauthGrantSnapshotModel(ctx.serverDB).aggregateStatus(
        config.appKey,
      );
      return {
        config: {
          appKey: redacted.appKey,
          baseUrl: redacted.baseUrl,
          portalUrl: redacted.portalUrl || null,
          tokenConfigured: redacted.hasAppToken,
        },
        sync: {
          accessGrantedCount: aggregate.accessGrantedCount,
          degradedCount: aggregate.degradedCount,
          latestFetchedAt: aggregate.latestFetchedAt,
          totalCount: aggregate.totalCount,
        },
      };
    }),

  getSyncStatus: adminBase
    .use(
      withAnyPlatformPermission([PLATFORM_PERMISSIONS.ROLE_READ, PLATFORM_PERMISSIONS.SYSTEM_READ]),
    )
    .input(z.object({ userId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const service = new EasyauthSyncService(ctx.serverDB);
      return service.getSyncStatus(input?.userId);
    }),

  triggerSync: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.ROLE_UPDATE))
    .input(
      z.object({
        reason: z.string().trim().min(1).max(2000),
        userId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertEasyauthDangerousReauth({
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: safeEasyauthReauthReason(input.reason),
        serverDB: ctx.serverDB,
        targetId: input.userId,
      });
      const service = new EasyauthSyncService(ctx.serverDB);
      return service.syncUser({
        actorUserId: ctx.userId!,
        reason: input.reason,
        userId: input.userId,
      });
    }),
});

/**
 * Admin root router (M02 + M04 surface).
 * Mounted as `admin` on lambda root when wired.
 */
export const adminRouter = router({
  agents: adminAgentsRouter,
  aiModels: adminAiModelsRouter,
  aiProviders: adminAiProvidersRouter,
  audit: adminAuditRouter,
  auth: adminAuthRouter,
  authSettings: adminAuthSettingsRouter,
  branding: adminBrandingRouter,
  connectors: adminConnectorsRouter,
  creds: adminCredsRouter,
  easyauth: adminEasyauthRouter,
  identityProviders: adminIdentityProvidersRouter,
  managedResources: adminManagedResourcesRouter,
  roles: adminRolesRouter,
  security: adminSecurityRouter,
  settings: adminSettingsRouter,
  sidebarLayout: adminSidebarLayoutRouter,
  skills: adminSkillsRouter,
  stats: adminStatsRouter,
  system: adminSystemRouter,
  users: adminUsersRouter,
});

export type AdminRouter = typeof adminRouter;
