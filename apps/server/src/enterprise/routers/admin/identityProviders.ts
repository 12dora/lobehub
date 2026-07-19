import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { enterpriseAccessGate, preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminIdentityProviderCallbackUrlsOutputSchema,
  adminIdentityProviderCreateInputSchema,
  adminIdentityProviderDeleteInputSchema,
  adminIdentityProviderDeleteOutputSchema,
  adminIdentityProviderDiscoverInputSchema,
  adminIdentityProviderDiscoveryOutputSchema,
  adminIdentityProviderGetInputSchema,
  adminIdentityProviderGetOutputSchema,
  adminIdentityProviderListInputSchema,
  adminIdentityProviderListOutputSchema,
  adminIdentityProviderMutationOutputSchema,
  adminIdentityProviderPublishInputSchema,
  adminIdentityProviderPublishOutputSchema,
  adminIdentityProviderRollbackInputSchema,
  adminIdentityProviderRollbackOutputSchema,
  adminIdentityProviderTestResultInputSchema,
  adminIdentityProviderTestResultOutputSchema,
  adminIdentityProviderTestStartInputSchema,
  adminIdentityProviderTestStartOutputSchema,
  adminIdentityProviderUpdateInputSchema,
  adminIdentityProviderValidateNetworkOutputSchema,
} from '../../contracts/identityProviders';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import { IdentityProviderValidationError } from '../../services/identityProvider/discoveryValidator';
import { IdentityProviderPublicationService } from '../../services/identityProvider/publicationService';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  createAdminIdentityProviderRuntime,
  isIdentityProviderFeatureEnabled,
} from './identityProvidersSupport';

const execute = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityProviderValidationError) {
      return throwEnterpriseError({
        code:
          error.code === 'OIDC_NETWORK_BLOCKED'
            ? PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED
            : PLATFORM_ERROR_CODES.PLATFORM_OIDC_DISCOVERY_FAILED,
      });
    }
    const message = error instanceof Error ? error.message : '';
    if (message.includes('REVISION_CONFLICT') || message.includes('revision changed')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT });
    }
    if (message.includes('NOT_FOUND')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND });
    }
    if (message.includes('SECRET_UNAVAILABLE') || message.includes('SECRET_NOT_READABLE')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE });
    }
    if (message.includes('NOT_TESTED') || message.includes('INVALID_SNAPSHOT')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT });
  }
};

const assertPublicationReauth = async (input: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
  targetId: string;
}) => {
  try {
    assertRecentReauth({ authenticatedAt: input.authenticatedAt, authMethod: input.authMethod });
  } catch (error) {
    try {
      await new PlatformAuditService(input.serverDB).append({
        action: input.action,
        actorUserId: input.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: input.reason,
        result: 'denied',
        targetId: input.targetId,
        targetType: 'identity_provider',
      });
    } catch (auditError) {
      console.error('[admin.identityProviders] reauth denied audit unavailable', {
        action: input.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

/** The flag middleware intentionally precedes DB/user/RBAC middleware: flag-off is a zero-I/O path. */
const identityProviderProcedure = preAccessAuthedProcedure
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
  .use(async ({ ctx, next }) =>
    next({
      ctx: {
        getIdentityProviderRuntime: () => createAdminIdentityProviderRuntime(ctx.serverDB),
      },
    }),
  );

export const adminIdentityProvidersRouter = router({
  getCallbackUrls: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .output(adminIdentityProviderCallbackUrlsOutputSchema)
    .query(({ ctx }) => execute(() => ctx.getIdentityProviderRuntime().admin.getCallbackUrls())),

  create: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_CREATE))
    .input(adminIdentityProviderCreateInputSchema)
    .output(adminIdentityProviderMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() => ctx.getIdentityProviderRuntime().admin.create(ctx.userId!, input)),
    ),

  delete: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_DELETE))
    .input(adminIdentityProviderDeleteInputSchema)
    .output(adminIdentityProviderDeleteOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() => ctx.getIdentityProviderRuntime().admin.delete(ctx.userId!, input)),
    ),

  discover: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderDiscoverInputSchema)
    .output(adminIdentityProviderDiscoveryOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() => ctx.getIdentityProviderRuntime().admin.discoverIssuer(input.issuer)),
    ),

  get: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .input(adminIdentityProviderGetInputSchema)
    .output(adminIdentityProviderGetOutputSchema)
    .query(({ ctx, input }) => execute(() => ctx.getIdentityProviderRuntime().admin.get(input.id))),

  list: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .input(adminIdentityProviderListInputSchema)
    .output(adminIdentityProviderListOutputSchema)
    .query(({ ctx, input }) => execute(() => ctx.getIdentityProviderRuntime().admin.list(input))),

  publish: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderPublishInputSchema)
    .output(adminIdentityProviderPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertPublicationReauth({
        action: 'admin.identityProviders.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      return execute(() =>
        new IdentityProviderPublicationService(ctx.serverDB).publish(ctx.userId!, input),
      );
    }),

  rollback: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderRollbackInputSchema)
    .output(adminIdentityProviderRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertPublicationReauth({
        action: 'admin.identityProviders.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      return execute(() =>
        new IdentityProviderPublicationService(ctx.serverDB).rollback(ctx.userId!, input),
      );
    }),

  testResult: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderTestResultInputSchema)
    .output(adminIdentityProviderTestResultOutputSchema)
    .query(({ ctx, input }) => {
      if (!ctx.sessionId) {
        throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT });
      }
      return execute(() =>
        ctx.getIdentityProviderRuntime().test.result({
          attemptId: input.attemptId,
          sessionId: ctx.sessionId!,
          userId: ctx.userId!,
        }),
      );
    }),

  testStart: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderTestStartInputSchema)
    .output(adminIdentityProviderTestStartOutputSchema)
    .mutation(({ ctx, input }) => {
      if (!ctx.sessionId) {
        throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT });
      }
      const runtime = ctx.getIdentityProviderRuntime();
      return execute(() =>
        runtime.test.start({
          ...input,
          redirectUri: runtime.admin.getCallbackUrls().test,
          sessionId: ctx.sessionId!,
          userId: ctx.userId!,
        }),
      );
    }),

  update: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_UPDATE))
    .input(adminIdentityProviderUpdateInputSchema)
    .output(adminIdentityProviderMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() => ctx.getIdentityProviderRuntime().admin.update(ctx.userId!, input)),
    ),

  validateNetwork: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderDiscoverInputSchema)
    .output(adminIdentityProviderValidateNetworkOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() => ctx.getIdentityProviderRuntime().admin.validateNetwork(input.issuer)),
    ),
});
