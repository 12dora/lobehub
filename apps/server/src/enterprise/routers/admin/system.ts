import { TRPCError } from '@trpc/server';
import { after } from 'next/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSystemAuthSnapshotStatusOutputSchema,
  adminSystemCancelJobInputSchema,
  adminSystemCancelJobOutputSchema,
  adminSystemGetInstanceRevisionsInputSchema,
  adminSystemGetInstanceRevisionsOutputSchema,
  adminSystemGetJobsInputSchema,
  adminSystemGetJobsOutputSchema,
  adminSystemGetStatusOutputSchema,
  adminSystemPrepareRestartInputSchema,
  adminSystemPrepareRestartOutputSchema,
  adminSystemRequestRestartInputSchema,
  adminSystemRequestRestartOutputSchema,
  adminSystemRetryJobInputSchema,
  adminSystemRetryJobOutputSchema,
} from '../../contracts/adminSystem';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  IdentityProviderSystemError,
  IdentityProviderSystemService,
} from '../../services/identityProvider/systemService';
import { PlatformAuditService } from '../../services/platformAudit';
import { PlatformSystemAdminService } from '../../services/platformSystem/adminService';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from '../../services/platformSystem/errors';
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
    authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { reason: string; requestId: string },
  action: 'admin.system.prepareRestart' | 'admin.system.requestRestart',
): Promise<void> => {
  try {
    assertRecentReauth({ authenticatedAt: ctx.authenticatedAt, authMethod: ctx.authMethod });
  } catch (error) {
    try {
      await new PlatformAuditService(ctx.serverDB).append({
        action,
        actorUserId: ctx.userId,
        afterDiff: { error: 'reauth_required' },
        reason: input.reason,
        requestId: input.requestId,
        result: 'denied',
        targetId: 'identity_provider_runtime',
        targetType: 'system',
      });
    } catch (auditError) {
      console.error('[admin.system] restart reauth denied audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    // Denial must still reject even if the audit write fails.
    throw error;
  }
};

const assertJobMutationReauth = async (
  ctx: {
    authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { jobId: string; reason: string; requestId: string },
  action: 'admin.system.jobs.cancel' | 'admin.system.jobs.retry',
): Promise<void> => {
  try {
    assertRecentReauth({ authenticatedAt: ctx.authenticatedAt, authMethod: ctx.authMethod });
  } catch (error) {
    try {
      await new PlatformAuditService(ctx.serverDB).append({
        action,
        actorUserId: ctx.userId,
        afterDiff: { error: 'reauth_required' },
        reason: input.reason,
        requestId: input.requestId,
        result: 'denied',
        targetId: input.jobId,
        targetType: 'platform_job',
      });
    } catch (auditError) {
      console.error('[admin.system] job reauth denied audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

export const adminSystemRouter = router({
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
        'admin.system.jobs.cancel',
      );
      return executePlatformSystem(() =>
        new PlatformSystemAdminService(ctx.serverDB).cancelJob(ctx.userId!, input),
      );
    }),

  getAuthSnapshotStatus: systemProcedure
    .output(adminSystemAuthSnapshotStatusOutputSchema)
    .query(({ ctx }) => execute(() => createSystemService(ctx.serverDB).getAuthSnapshotStatus())),

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
        'admin.system.prepareRestart',
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
        'admin.system.requestRestart',
      );
      return execute(() => createSystemService(ctx.serverDB).requestRestart(ctx.userId!, input));
    }),

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
        'admin.system.jobs.retry',
      );
      return executePlatformSystem(() =>
        new PlatformSystemAdminService(ctx.serverDB).retryJob(ctx.userId!, input),
      );
    }),
});
