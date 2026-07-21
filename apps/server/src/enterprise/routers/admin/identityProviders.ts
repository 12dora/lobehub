import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { toPublicIdentityProviderDraft } from '@/database/models/platform';
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
  adminIdentityProviderRevisionHistoryOutputSchema,
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
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertRecentReauth } from '../../guards/reauth';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { PlatformSecretService } from '../../security/secret';
import { IdentityProviderValidationError } from '../../services/identityProvider/discoveryValidator';
import { IdentityProviderPublicationService } from '../../services/identityProvider/publicationService';
import { IdentityProviderSecretStore } from '../../services/identityProvider/secretStore';
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
    if (message.includes('PLATFORM_FEATURE_DISABLED') || message === 'PLATFORM_FEATURE_DISABLED') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
        httpCode: 'FORBIDDEN',
      });
    }
    if (message.includes('PLATFORM_SECRET_REQUIRED') || message === 'PLATFORM_SECRET_REQUIRED') {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
    }
    // APP_URL missing is a deploy-time config gap; preserve stable message for setup guidance UI.
    if (message.includes('PLATFORM_APP_URL_INVALID') || message === 'PLATFORM_APP_URL_INVALID') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        message: 'PLATFORM_APP_URL_INVALID',
      });
    }
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

export const identitySecretMutationRequiresReauth = (mutation: {
  operation: 'clear' | 'keep' | 'replace';
}): boolean => mutation.operation === 'replace' || mutation.operation === 'clear';

const safeIdentityDeniedReason = async (input: {
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}): Promise<string | null> => {
  if (containsEnterpriseSecretMaterial(input.reason)) return null;
  const credentialValues = (input.replacementSecrets ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (input.currentSecretTargetId) {
    try {
      const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise();
      if (!secretService) return null;
      const currentSecret = await new IdentityProviderSecretStore(
        input.serverDB,
        secretService,
      ).resolveCurrentClientSecret(input.currentSecretTargetId);
      if (!currentSecret) return null;
      credentialValues.push(currentSecret);
    } catch {
      return null;
    }
  }

  let reason = input.reason;
  for (const value of credentialValues.sort((a, b) => b.length - a.length)) {
    reason = reason.replaceAll(value, '[REDACTED]');
  }
  return containsEnterpriseSecretMaterial(reason) ? null : reason;
};

const assertIdentityDangerousReauth = async (input: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
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
        reason: await safeIdentityDeniedReason(input),
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
  .use(withAdminMutationRateLimit())
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
    .mutation(async ({ ctx, input }) => {
      if (identitySecretMutationRequiresReauth(input.secret)) {
        await assertIdentityDangerousReauth({
          action: 'admin.identityProviders.create',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          currentSecretTargetId: null,
          reason: input.reason,
          replacementSecrets: input.secret.operation === 'replace' ? [input.secret.value] : [],
          serverDB: ctx.serverDB,
          targetId: input.providerKey,
        });
      }
      return execute(() => ctx.getIdentityProviderRuntime().admin.create(ctx.userId!, input));
    }),

  delete: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_DELETE))
    .input(adminIdentityProviderDeleteInputSchema)
    .output(adminIdentityProviderDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertIdentityDangerousReauth({
        action: 'admin.identityProviders.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      return execute(() => ctx.getIdentityProviderRuntime().admin.delete(ctx.userId!, input));
    }),

  discover: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderDiscoverInputSchema)
    .output(adminIdentityProviderDiscoveryOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() =>
        ctx.getIdentityProviderRuntime().admin.discoverIssuer(ctx.userId!, input.issuer),
      ),
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

  listPublishedRevisions: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .input(adminIdentityProviderGetInputSchema)
    .output(adminIdentityProviderRevisionHistoryOutputSchema)
    .query(({ ctx, input }) =>
      execute(() =>
        new IdentityProviderPublicationService(ctx.serverDB).listPublishedRevisions(input.id),
      ),
    ),

  publish: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderPublishInputSchema)
    .output(adminIdentityProviderPublishOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertIdentityDangerousReauth({
        action: 'admin.identityProviders.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      return execute(async () =>
        toPublicIdentityProviderDraft(
          await new IdentityProviderPublicationService(ctx.serverDB).publish(ctx.userId!, input),
        ),
      );
    }),

  rollback: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderRollbackInputSchema)
    .output(adminIdentityProviderRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertIdentityDangerousReauth({
        action: 'admin.identityProviders.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      return execute(async () =>
        toPublicIdentityProviderDraft(
          await new IdentityProviderPublicationService(ctx.serverDB).rollback(ctx.userId!, input),
        ),
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
    .mutation(async ({ ctx, input }) => {
      if (identitySecretMutationRequiresReauth(input.secret)) {
        await assertIdentityDangerousReauth({
          action: 'admin.identityProviders.update',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          currentSecretTargetId: input.id,
          reason: input.reason,
          replacementSecrets: input.secret.operation === 'replace' ? [input.secret.value] : [],
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
      }
      return execute(() => ctx.getIdentityProviderRuntime().admin.update(ctx.userId!, input));
    }),

  validateNetwork: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_TEST))
    .input(adminIdentityProviderDiscoverInputSchema)
    .output(adminIdentityProviderValidateNetworkOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() =>
        ctx.getIdentityProviderRuntime().admin.validateNetwork(ctx.userId!, input.issuer),
      ),
    ),
});
