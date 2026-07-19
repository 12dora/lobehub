import { after } from 'next/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { enterpriseAccessGate, preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSystemAuthSnapshotStatusOutputSchema,
  adminSystemPrepareRestartInputSchema,
  adminSystemPrepareRestartOutputSchema,
  adminSystemRequestRestartInputSchema,
  adminSystemRequestRestartOutputSchema,
} from '../../contracts/adminSystem';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import {
  IdentityProviderSystemError,
  IdentityProviderSystemService,
} from '../../services/identityProvider/systemService';
import { PlatformAuditService } from '../../services/platformAudit';
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
  .use(enterpriseAccessGate)
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withPlatformPermission(PLATFORM_PERMISSIONS.OIDC_PUBLISH));

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

const assertRestartReauth = async (
  ctx: {
    authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  input: { reason: string; requestId: string },
): Promise<void> => {
  try {
    assertRecentReauth({ authenticatedAt: ctx.authenticatedAt, authMethod: ctx.authMethod });
  } catch (error) {
    try {
      await new PlatformAuditService(ctx.serverDB).append({
        action: 'admin.system.requestRestart',
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
    throw error;
  }
};

export const adminSystemRouter = router({
  getAuthSnapshotStatus: systemProcedure
    .output(adminSystemAuthSnapshotStatusOutputSchema)
    .query(({ ctx }) => execute(() => createSystemService(ctx.serverDB).getAuthSnapshotStatus())),

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
      );
      return execute(() => createSystemService(ctx.serverDB).requestRestart(ctx.userId!, input));
    }),
});
