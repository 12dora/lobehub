import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminUsersReplaceGlobalRolesInputSchema,
  adminUsersReplaceGlobalRolesOutputSchema,
} from '../contracts/adminUsers';
import { withActiveUser } from '../guards/activeUser';
import { throwEnterpriseError } from '../guards/enterpriseErrors';
import { withAnyPlatformPermission, withPlatformPermission } from '../guards/platformPermission';
import { assertRecentReauth } from '../guards/reauth';
import { AdminUserNotFoundError, AdminUserService } from '../services/adminUserService';
import { ensureAiCatalogReadinessRegistered } from '../services/aiCatalog';
import { ensureConnectorCatalogReadinessRegistered } from '../services/connectorCatalog/runtimeReadiness';
import { EasyauthSyncService } from '../services/easyauthSync';
import { PlatformAuditService } from '../services/platformAudit';
import { LastSuperAdminError, PlatformRbacService } from '../services/platformRbac';
import { ensureSkillCatalogReadinessRegistered } from '../services/skillCatalog';
import { adminAgentsRouter } from './admin/agents';
import { adminAiModelsRouter, adminAiProvidersRouter } from './admin/aiCatalog';
import { adminBrandingRouter } from './admin/branding';
import { adminConnectorsRouter } from './admin/connectors';
import { adminIdentityProvidersRouter } from './admin/identityProviders';
import { adminManagedResourcesRouter } from './admin/managedResources';
import { adminSettingsRouter } from './admin/settings';
import { adminSkillsRouter } from './admin/skills';
import { adminSystemRouter } from './admin/system';
import { adminUsersRouter } from './admin/users';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

ensureAiCatalogReadinessRegistered();
ensureConnectorCatalogReadinessRegistered();
ensureSkillCatalogReadinessRegistered();

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
      const service = new EasyauthSyncService(ctx.serverDB);
      return service.syncUser({
        actorUserId: ctx.userId!,
        reason: input.reason,
        userId: input.userId,
      });
    }),
});

export const adminAuditRouter = router({
  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
    .input(
      z
        .object({
          actorUserId: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          targetId: z.string().optional(),
          targetType: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const service = new PlatformAuditService(ctx.serverDB);
      return service.list({
        actorUserId: input?.actorUserId,
        cursor: input?.cursor,
        limit: input?.limit,
        targetId: input?.targetId,
        targetType: input?.targetType,
      });
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new PlatformAuditService(ctx.serverDB);
      const row = await service.findById(input.id);
      if (!row) {
        throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }
      return row;
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
  branding: adminBrandingRouter,
  connectors: adminConnectorsRouter,
  easyauth: adminEasyauthRouter,
  identityProviders: adminIdentityProvidersRouter,
  managedResources: adminManagedResourcesRouter,
  roles: adminRolesRouter,
  settings: adminSettingsRouter,
  skills: adminSkillsRouter,
  system: adminSystemRouter,
  users: adminUsersRouter,
});

export type AdminRouter = typeof adminRouter;
