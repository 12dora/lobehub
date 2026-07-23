import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSecretRotationCancelInputSchema,
  adminSecretRotationCancelOutputSchema,
  adminSecretRotationGetInputSchema,
  adminSecretRotationGetOutputSchema,
  adminSecretRotationListInputSchema,
  adminSecretRotationListOutputSchema,
  adminSecretRotationRetryInputSchema,
  adminSecretRotationRetryOutputSchema,
  adminSecretRotationStartInputSchema,
  adminSecretRotationStartOutputSchema,
} from '../../contracts/adminSecretRotation';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { PlatformAuditService } from '../../services/platformAudit';
import { PlatformSecretRotationAdminService } from '../../services/secretRewrap';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
  PlatformSecretRewrapNotFoundError,
  PlatformSecretRewrapProviderError,
} from '../../services/secretRewrap/errors';

const secretRotationBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const mapSecretRotationError = (error: unknown): never => {
  if (error instanceof PlatformSecretRewrapNotFoundError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
    });
  }
  if (error instanceof PlatformSecretRewrapConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof PlatformSecretRewrapInvalidError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      httpCode: 'BAD_REQUEST',
    });
  }
  if (error instanceof PlatformSecretRewrapProviderError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  console.error('[admin.security.secretRotation] operation unavailable', {
    errorClass: error instanceof Error ? error.name : 'UnknownError',
  });
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Platform temporarily unavailable',
  });
};

const assertMutationReauth = async (
  ctx: {
    authenticatedAt?: Date | null;
    authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { reason: string; requestId: string },
  action: string,
  targetId: string,
): Promise<void> =>
  assertDangerousReauthWithAudit({
    action,
    actorUserId: ctx.userId,
    auditFailureLog: '[admin.security.secretRotation] reauth denied audit unavailable',
    // Legacy path only logged errorClass (no action).
    auditFailureMeta: {},
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    reason: input.reason,
    requestId: input.requestId,
    serverDB: ctx.serverDB,
    targetId,
    targetType: 'secret_rotation',
  });

const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    return mapSecretRotationError(error);
  }
};

export const adminSecretRotationRouter = router({
  cancel: secretRotationBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSecretRotationCancelInputSchema)
    .output(adminSecretRotationCancelOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertMutationReauth(
        {
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        'admin.security.secretRotation.cancel',
        input.jobId,
      );
      return execute(() =>
        new PlatformSecretRotationAdminService(ctx.serverDB).cancel(ctx.userId!, input),
      );
    }),

  get: secretRotationBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .input(adminSecretRotationGetInputSchema)
    .output(adminSecretRotationGetOutputSchema)
    .query(({ ctx, input }) =>
      execute(() => new PlatformSecretRotationAdminService(ctx.serverDB).get(input.jobId)),
    ),

  list: secretRotationBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .input(adminSecretRotationListInputSchema)
    .output(adminSecretRotationListOutputSchema)
    .query(({ ctx, input }) =>
      execute(() => new PlatformSecretRotationAdminService(ctx.serverDB).list(input)),
    ),

  retry: secretRotationBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSecretRotationRetryInputSchema)
    .output(adminSecretRotationRetryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertMutationReauth(
        {
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        'admin.security.secretRotation.retry',
        input.jobId,
      );
      return execute(() =>
        new PlatformSecretRotationAdminService(ctx.serverDB).retry(ctx.userId!, input),
      );
    }),

  start: secretRotationBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminSecretRotationStartInputSchema)
    .output(adminSecretRotationStartOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertMutationReauth(
        {
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          serverDB: ctx.serverDB,
          userId: ctx.userId!,
        },
        input,
        'admin.security.secretRotation.start',
        input.targetKeyId,
      );
      return execute(() =>
        new PlatformSecretRotationAdminService(ctx.serverDB).start(ctx.userId!, input),
      );
    }),
});

export const adminSecurityRouter = router({ secretRotation: adminSecretRotationRouter });
