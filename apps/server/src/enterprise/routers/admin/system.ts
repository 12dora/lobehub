import { TRPCError } from '@trpc/server';
import { after } from 'next/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { rebuildSandboxProviderFromSettings } from '@/server/services/sandbox/factory';

import {
  adminSystemAuthSnapshotStatusOutputSchema,
  adminSystemCancelDocumentRenderJobInputSchema,
  adminSystemCancelDocumentRenderJobOutputSchema,
  adminSystemCancelJobInputSchema,
  adminSystemCancelJobOutputSchema,
  adminSystemGetDocumentRenderSettingsOutputSchema,
  adminSystemGetDocumentRenderStatusOutputSchema,
  adminSystemGetInfraSettingsOutputSchema,
  adminSystemGetInstanceRevisionsInputSchema,
  adminSystemGetInstanceRevisionsOutputSchema,
  adminSystemGetJobsInputSchema,
  adminSystemGetJobsOutputSchema,
  adminSystemGetSandboxSettingsOutputSchema,
  adminSystemGetStatusOutputSchema,
  adminSystemPrepareRestartInputSchema,
  adminSystemPrepareRestartOutputSchema,
  adminSystemRequestRestartInputSchema,
  adminSystemRequestRestartOutputSchema,
  adminSystemRetryDocumentRenderJobInputSchema,
  adminSystemRetryDocumentRenderJobOutputSchema,
  adminSystemRetryJobInputSchema,
  adminSystemRetryJobOutputSchema,
  adminSystemRunDocumentRenderGcInputSchema,
  adminSystemRunDocumentRenderGcOutputSchema,
  adminSystemTestDependencyInputSchema,
  adminSystemTestDependencyOutputSchema,
  adminSystemUpdateDocumentRenderSettingsInputSchema,
  adminSystemUpdateDocumentRenderSettingsOutputSchema,
  adminSystemUpdateInfraSettingsInputSchema,
  adminSystemUpdateInfraSettingsOutputSchema,
  adminSystemUpdateSandboxSettingsInputSchema,
  adminSystemUpdateSandboxSettingsOutputSchema,
} from '../../contracts/adminSystem';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { AUDIT_ACTION } from '../../services/audit/auditActionCatalog';
import {
  cancelDocumentRenderJob,
  enqueueDocumentRenderGcJob,
  retryDocumentRenderJob,
} from '../../services/documentRender';
import {
  DOCUMENT_RENDER_SETTINGS_AUDIT_ACTION,
  DOCUMENT_RENDER_SETTINGS_AUDIT_TARGET_TYPE,
  getDocumentRenderSettingsView,
  invalidateEffectiveDocumentRenderSettings,
  summarizeDocumentRenderAfterDiff,
  updateDocumentRenderSettings,
} from '../../services/documentRenderSettings';
import {
  IdentityProviderSystemError,
  IdentityProviderSystemService,
} from '../../services/identityProvider/systemService';
import {
  getMailSettings,
  getObjectStorageSettings,
  INFRA_SETTINGS_AUDIT_TARGET_TYPE,
  InfraSettingsSecretRequiredError,
  mailSecretChanged,
  objectStorageSecretChanged,
  publishInfraInvalidation,
  summarizeMailAfterDiff,
  summarizeObjectStorageAfterDiff,
  updateMailSettings,
  updateObjectStorageSettings,
} from '../../services/infraSettings';
import { InfraSettingsDestinationError } from '../../services/infraSettings/destinationPolicy';
import { InfraSettingsSecretReuseError } from '../../services/infraSettings/errors';
import { PlatformAuditService } from '../../services/platformAudit';
import { PlatformSystemAdminService } from '../../services/platformSystem/adminService';
import { testDocumentRenderDependency } from '../../services/platformSystem/documentRenderProbe';
import { getDocumentRenderStatus } from '../../services/platformSystem/documentRenderStatus';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from '../../services/platformSystem/errors';
import { invalidateInfraHealthMemo } from '../../services/platformSystem/infraHealthMemo';
import { InfraSettingsService } from '../../services/platformSystem/infraSettingsService';
import {
  getSandboxSettingsView,
  SANDBOX_SETTINGS_AUDIT_ACTION,
  SANDBOX_SETTINGS_AUDIT_TARGET_TYPE,
  summarizeSandboxAfterDiff,
  toSandboxSettingsOutput,
  updateSandboxSettings,
} from '../../services/sandboxSettings';
import { isIdentityProviderFeatureEnabled } from './identityProvidersSupport';

const createSystemService = (db: ConstructorParameters<typeof IdentityProviderSystemService>[0]) =>
  new IdentityProviderSystemService(db, undefined, undefined, (task) => after(task));

const systemProcedure = preAccessAuthedProcedure
  .use(({ next }) => {
    if (!isIdentityProviderFeatureEnabled()) {
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
        httpCode: 'FORBIDDEN',
      });
    }
    return next();
  })
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit())
  .use(withPlatformPermission(PLATFORM_PERMISSIONS.OIDC_PUBLISH));

const platformSystemBase = preAccessAuthedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityProviderSystemError) {
      if (error.code === 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_UNSUPPORTED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (error.code === 'PLATFORM_IDENTITY_RESTART_NOT_PENDING') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_NOT_PENDING,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (error.code === 'PLATFORM_IDENTITY_RESTART_INTENT_EXPIRED') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_INTENT_EXPIRED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (
        error.code === 'PLATFORM_IDENTITY_RESTART_INTENT_INVALID' ||
        error.code === 'PLATFORM_IDENTITY_RESTART_CONFLICT'
      ) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_INTENT_INVALID,
          httpCode: 'CONFLICT',
        });
      }
    }
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
};

const executePlatformSystem = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PlatformSystemJobNotFoundError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }
    if (error instanceof PlatformSystemJobConflictError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        httpCode: 'CONFLICT',
      });
    }
    if (error instanceof PlatformSystemJobInvalidError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        httpCode: 'BAD_REQUEST',
      });
    }
    if (error instanceof PlatformRevisionConflictError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        details: {
          currentRevision: error.details?.currentRevision ?? null,
          expectedRevision: error.details?.expectedRevision ?? null,
          resourceId: error.details?.resourceId ?? null,
        },
        httpCode: 'CONFLICT',
      });
    }
    if (
      error instanceof InfraSettingsSecretRequiredError ||
      error instanceof InfraSettingsSecretReuseError
    ) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        details: { field: error.field },
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
    if (error instanceof InfraSettingsDestinationError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
        details: { field: error.field },
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
    console.error('[admin.system] operation unavailable', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Platform temporarily unavailable',
    });
  }
};

const assertRestartReauth = async (
  ctx: {
    authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { reason: string; requestId: string },
  action: typeof AUDIT_ACTION.SYSTEM_PREPARE_RESTART | typeof AUDIT_ACTION.SYSTEM_REQUEST_RESTART,
): Promise<void> =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    serverDB: ctx.serverDB,
    denied: {
      action,
      actorUserId: ctx.userId,
      reason: input.reason,
      requestId: input.requestId,
      targetId: 'identity_provider_runtime',
      targetType: 'system',
    },
  });

const assertJobMutationReauth = async (
  ctx: {
    authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { jobId: string; reason?: string | null; requestId: string },
  action: typeof AUDIT_ACTION.SYSTEM_JOBS_CANCEL | typeof AUDIT_ACTION.SYSTEM_JOBS_RETRY,
): Promise<void> =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    serverDB: ctx.serverDB,
    denied: {
      action,
      actorUserId: ctx.userId,
      reason: input.reason,
      requestId: input.requestId,
      targetId: input.jobId,
      targetType: 'platform_job',
    },
  });

export const adminSystemRouter = router({
  cancelDocumentRenderJob: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemCancelDocumentRenderJobInputSchema)
    .output(adminSystemCancelDocumentRenderJobOutputSchema)
    .mutation(({ ctx, input }) =>
      executePlatformSystem(() => cancelDocumentRenderJob(ctx.serverDB, input.jobId)),
    ),

  cancelJob: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemCancelJobInputSchema)
    .output(adminSystemCancelJobOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertJobMutationReauth(
        {
          authMethod: ctx.authMethod,
          authenticatedAt: ctx.authenticatedAt,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        AUDIT_ACTION.SYSTEM_JOBS_CANCEL,
      );
      return executePlatformSystem(() =>
        new PlatformSystemAdminService(ctx.serverDB).cancelJob(ctx.userId!, input),
      );
    }),

  getAuthSnapshotStatus: systemProcedure
    .output(adminSystemAuthSnapshotStatusOutputSchema)
    .query(({ ctx }) => execute(() => createSystemService(ctx.serverDB).getAuthSnapshotStatus())),

  getDocumentRenderSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminSystemGetDocumentRenderSettingsOutputSchema)
    .query(() => executePlatformSystem(async () => getDocumentRenderSettingsView())),

  getDocumentRenderStatus: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminSystemGetDocumentRenderStatusOutputSchema)
    .query(({ ctx }) => executePlatformSystem(() => getDocumentRenderStatus(ctx.serverDB))),

  getInfraSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminSystemGetInfraSettingsOutputSchema)
    .query(() => executePlatformSystem(async () => new InfraSettingsService().getInfraSettings())),

  getInstanceRevisions: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .input(adminSystemGetInstanceRevisionsInputSchema)
    .output(adminSystemGetInstanceRevisionsOutputSchema)
    .query(({ ctx, input }) =>
      executePlatformSystem(() =>
        new PlatformSystemAdminService(ctx.serverDB).getInstanceRevisions(input),
      ),
    ),

  getJobs: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .input(adminSystemGetJobsInputSchema)
    .output(adminSystemGetJobsOutputSchema)
    .query(({ ctx, input }) =>
      executePlatformSystem(() => new PlatformSystemAdminService(ctx.serverDB).getJobs(input)),
    ),

  getSandboxSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminSystemGetSandboxSettingsOutputSchema)
    .query(() =>
      executePlatformSystem(async () => toSandboxSettingsOutput(await getSandboxSettingsView())),
    ),

  getStatus: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminSystemGetStatusOutputSchema)
    .query(({ ctx }) =>
      executePlatformSystem(() => new PlatformSystemAdminService(ctx.serverDB).getStatus()),
    ),

  prepareRestart: systemProcedure
    .input(adminSystemPrepareRestartInputSchema)
    .output(adminSystemPrepareRestartOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertRestartReauth(
        {
          authMethod: ctx.authMethod,
          authenticatedAt: ctx.authenticatedAt,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        AUDIT_ACTION.SYSTEM_PREPARE_RESTART,
      );
      return execute(() => createSystemService(ctx.serverDB).prepareRestart(ctx.userId!, input));
    }),

  requestRestart: systemProcedure
    .input(adminSystemRequestRestartInputSchema)
    .output(adminSystemRequestRestartOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertRestartReauth(
        {
          authMethod: ctx.authMethod,
          authenticatedAt: ctx.authenticatedAt,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        AUDIT_ACTION.SYSTEM_REQUEST_RESTART,
      );
      return execute(() => createSystemService(ctx.serverDB).requestRestart(ctx.userId!, input));
    }),

  retryDocumentRenderJob: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemRetryDocumentRenderJobInputSchema)
    .output(adminSystemRetryDocumentRenderJobOutputSchema)
    .mutation(({ ctx, input }) =>
      executePlatformSystem(() => retryDocumentRenderJob(ctx.serverDB, input.jobId)),
    ),

  runDocumentRenderGc: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemRunDocumentRenderGcInputSchema)
    .output(adminSystemRunDocumentRenderGcOutputSchema)
    .mutation(({ ctx }) =>
      executePlatformSystem(async () => {
        const result = await enqueueDocumentRenderGcJob(ctx.serverDB, {
          force: true,
          requestedBy: ctx.userId,
        });
        return { jobId: result.jobId, ok: true };
      }),
    ),

  retryJob: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemRetryJobInputSchema)
    .output(adminSystemRetryJobOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertJobMutationReauth(
        {
          authMethod: ctx.authMethod,
          authenticatedAt: ctx.authenticatedAt,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        AUDIT_ACTION.SYSTEM_JOBS_RETRY,
      );
      return executePlatformSystem(() =>
        new PlatformSystemAdminService(ctx.serverDB).retryJob(ctx.userId!, input),
      );
    }),

  testDependency: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemTestDependencyInputSchema)
    .output(adminSystemTestDependencyOutputSchema)
    .mutation(({ input }) =>
      executePlatformSystem(async () => {
        if (input.dependency === 'documentRender') return testDocumentRenderDependency();
        return new InfraSettingsService().testDependency({
          ...input,
          dependency: input.dependency,
        });
      }),
    ),

  updateDocumentRenderSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemUpdateDocumentRenderSettingsInputSchema)
    .output(adminSystemUpdateDocumentRenderSettingsOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executePlatformSystem(async () => {
        const view = await ctx.serverDB.transaction(async (tx) => {
          const row = await updateDocumentRenderSettings(tx, {
            actorId: ctx.userId!,
            config: input.config,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
          });
          await new PlatformAuditService(tx).append({
            action: DOCUMENT_RENDER_SETTINGS_AUDIT_ACTION,
            actorUserId: ctx.userId!,
            afterDiff: summarizeDocumentRenderAfterDiff(input.config),
            configRevision: row.revision,
            reason: input.reason,
            result: 'success',
            targetId: 'documentRender',
            targetType: DOCUMENT_RENDER_SETTINGS_AUDIT_TARGET_TYPE,
          });
          return row;
        });
        invalidateEffectiveDocumentRenderSettings();
        invalidateInfraHealthMemo();
        return view;
      }),
    ),

  updateInfraSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemUpdateInfraSettingsInputSchema)
    .output(adminSystemUpdateInfraSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const targetId = input.dependency === 'objectStorage' ? 'object_storage' : 'mail';
      const action =
        input.dependency === 'objectStorage'
          ? AUDIT_ACTION.SYSTEM_INFRA_OBJECT_STORAGE_UPDATE
          : AUDIT_ACTION.SYSTEM_INFRA_MAIL_UPDATE;
      await assertDangerousReauthWithAudit({
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        denied: {
          action,
          actorUserId: ctx.userId!,
          reason: input.reason,
          targetId,
          targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
        },
      });

      return executePlatformSystem(async () => {
        const applied = await ctx.serverDB.transaction(async (tx) => {
          if (input.dependency === 'objectStorage') {
            const previous = await getObjectStorageSettings(tx);
            const row = await updateObjectStorageSettings(tx, {
              config: input.config,
              expectedRevision: input.expectedRevision,
              updatedBy: ctx.userId!,
            });
            await new PlatformAuditService(tx).append({
              action: AUDIT_ACTION.SYSTEM_INFRA_OBJECT_STORAGE_UPDATE,
              actorUserId: ctx.userId!,
              afterDiff: summarizeObjectStorageAfterDiff(
                row.config,
                objectStorageSecretChanged(previous.config, row.config),
              ),
              configRevision: row.revision,
              reason: input.reason,
              result: 'success',
              targetId,
              targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
            });
            return {
              revision: row.revision,
              source: row.config.enabled ? ('db' as const) : ('env' as const),
            };
          }

          const previous = await getMailSettings(tx);
          const row = await updateMailSettings(tx, {
            config: input.config,
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: AUDIT_ACTION.SYSTEM_INFRA_MAIL_UPDATE,
            actorUserId: ctx.userId!,
            afterDiff: summarizeMailAfterDiff(
              row.config,
              mailSecretChanged(previous.config, row.config),
            ),
            configRevision: row.revision,
            reason: input.reason,
            result: 'success',
            targetId,
            targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
          });
          return {
            revision: row.revision,
            source: row.config.enabled ? ('db' as const) : ('env' as const),
          };
        });

        await publishInfraInvalidation(applied.revision);
        return { appliedAt: new Date(), revision: applied.revision, source: applied.source };
      });
    }),

  updateSandboxSettings: platformSystemBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSystemUpdateSandboxSettingsInputSchema)
    .output(adminSystemUpdateSandboxSettingsOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executePlatformSystem(async () => {
        const view = await ctx.serverDB.transaction(async (tx) => {
          const row = await updateSandboxSettings(tx, {
            config: input.config,
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: SANDBOX_SETTINGS_AUDIT_ACTION,
            actorUserId: ctx.userId!,
            afterDiff: summarizeSandboxAfterDiff(input.config),
            configRevision: row.revision,
            reason: input.reason,
            result: 'success',
            targetId: 'sandbox',
            targetType: SANDBOX_SETTINGS_AUDIT_TARGET_TYPE,
          });
          return row;
        });
        invalidateInfraHealthMemo();
        await rebuildSandboxProviderFromSettings();
        return toSandboxSettingsOutput(view);
      }),
    ),
});
