import { after } from 'next/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminModulesGetOutputSchema,
  adminModulesRequestRestartInputSchema,
  adminModulesRequestRestartOutputSchema,
  adminModulesUpdateInputSchema,
  adminModulesUpdateOutputSchema,
} from '../../contracts/adminModules';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import {
  ProcessRestartController,
  resolveRestartCapability,
} from '../../services/identityProvider/restartController';
import {
  type AuthoritativeModuleSettingsRow,
  getModuleSettingsSnapshot,
  getPendingRestartModules,
  type ModuleSettingsSnapshot,
  updateModuleSettings,
} from '../../services/moduleSettings';
import { PlatformAuditService } from '../../services/platformAudit';
import { getPlatformInstanceId } from '../../services/platformInstance/heartbeatRuntime';

const modulesBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const COMPLIANCE_MODULE_IDS = ['audit', 'moderation'] as const;

const toView = async (snapshot: ModuleSettingsSnapshot) => {
  const capability = resolveRestartCapability();
  return {
    instanceId: getPlatformInstanceId(),
    pendingRestart: await getPendingRestartModules(),
    restart: {
      supported: capability.supported,
      ...(capability.reason ? { reason: capability.reason } : {}),
    },
    snapshot,
  };
};

/** Decide reauth from the authoritative DB map (missing key = on). */
export const isTurningOffCompliance = (
  authoritative: Pick<AuthoritativeModuleSettingsRow, 'modules'>,
  patch: Partial<Record<(typeof COMPLIANCE_MODULE_IDS)[number], boolean>>,
): boolean =>
  COMPLIANCE_MODULE_IDS.some((id) => patch[id] === false && (authoritative.modules[id] ?? true));

export const adminModulesRouter = router({
  get: modulesBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminModulesGetOutputSchema)
    .query(async () => toView(await getModuleSettingsSnapshot())),

  requestRestart: modulesBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminModulesRequestRestartInputSchema)
    .output(adminModulesRequestRestartOutputSchema)
    .mutation(async () => {
      const capability = resolveRestartCapability();
      if (!capability.supported) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_UNSUPPORTED,
          details: { reason: capability.reason },
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      const controller = new ProcessRestartController();
      after(() => {
        void controller.schedule({
          ownerFence: 'modules',
          requestId: `modules-restart:${getPlatformInstanceId()}`,
        });
      });
      return { ok: true as const };
    }),

  update: modulesBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminModulesUpdateInputSchema)
    .output(adminModulesUpdateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const snapshot = await updateModuleSettings({
        actorUserId: ctx.userId!,
        db: ctx.serverDB,
        expectedRevision: input.expectedRevision,
        modules: input.modules,
        onAuthoritative: async (row) => {
          if (!isTurningOffCompliance(row, input.modules)) return;
          await assertDangerousReauthWithAudit({
            authenticatedAt: ctx.authenticatedAt,
            authMethod: ctx.authMethod,
            denied: {
              action: 'admin.modules.update',
              actorUserId: ctx.userId!,
              beforeDiff: {
                modules: row.modules,
                revision: row.revision,
              },
              reason: 'reauth_required',
              targetId: 'global',
              targetType: 'system',
            },
            serverDB: ctx.serverDB,
          });
        },
        setupCompleted: input.setupCompleted,
        writeAudit: async (tx, before, after) => {
          await new PlatformAuditService(tx).append({
            action: 'admin.modules.update',
            actorUserId: ctx.userId!,
            afterDiff: {
              modules: after.modules,
              revision: after.revision,
              setupCompletedAt: after.setupCompletedAt?.toISOString() ?? null,
            },
            beforeDiff: {
              modules: before.modules,
              revision: before.revision,
              setupCompletedAt: before.setupCompletedAt?.toISOString() ?? null,
            },
            configRevision: after.revision,
            result: 'success',
            targetId: 'global',
            targetType: 'system',
          });
        },
      });

      return toView(snapshot);
    }),
});
