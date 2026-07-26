import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { toPublicIdentityProviderDraft } from '@/database/models/platform';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminIdentityProviderCallbackUrlsOutputSchema,
  adminIdentityProviderCreateInputSchema,
  adminIdentityProviderDeleteInputSchema,
  adminIdentityProviderDeleteOutputSchema,
  adminIdentityProviderDisableInputSchema,
  adminIdentityProviderDisableOutputSchema,
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
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { PlatformSecretError, PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { IdentityProviderValidationError } from '../../services/identityProvider/discoveryValidator';
import { IdentityProviderPublicationService } from '../../services/identityProvider/publicationService';
import { IdentityProviderSecretStore } from '../../services/identityProvider/secretStore';
import {
  createAdminIdentityProviderRuntime,
  isIdentityProviderFeatureEnabled,
} from './identityProvidersSupport';

const enterpriseCodeFromError = (error: unknown): string | null => {
  if (error instanceof PlatformSecretError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
};

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
    // Real path when ENABLE_DATABASE_OIDC=1 without PLATFORM_MASTER_KEY:
    // PlatformSecretService.fromEnvOrThrowIfEnterprise throws PlatformSecretError
    // (message is a prose string; stable code lives on `.code`).
    const enterpriseCode = enterpriseCodeFromError(error);
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
    }
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE });
    }
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT });
    }
    const message = error instanceof Error ? error.message : '';
    // Legacy string throws from support helpers (APP_URL gap, explicit SECRET_REQUIRED).
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
    if (message.includes('DRAFT_REQUIRED') || message.includes('NOT_DRAFT')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { reason: 'identity_provider_draft_required' },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (message.includes('NOT_TESTED')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { reason: 'identity_provider_test_required' },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (message.includes('INVALID_SNAPSHOT')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    // Untyped / unexpected failures are infrastructure or programming errors —
    // do not mislabel them as client input validation.
    console.error('[admin.identityProviders] unexpected operation failure', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Identity provider operation failed',
    });
  }
};

export const identitySecretMutationRequiresReauth = (mutation: {
  operation: 'clear' | 'keep' | 'replace';
}): boolean => mutation.operation === 'replace' || mutation.operation === 'clear';

/**
 * Redact known client-secret values and pattern-detected secret material from an
 * admin-supplied reason. Used for both denied-reauth audits and success-path audits
 * so opaque secrets pasted into free-text reason never land in the append-only log.
 */
const sanitizeIdentityReason = async (input: {
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
      // Fail closed: without the current secret we cannot prove the reason is free of it.
      if (!currentSecret) return null;
      credentialValues.push(currentSecret);
    } catch {
      // Secret store/outage: redact entire reason rather than risk persisting the opaque secret.
      return null;
    }
  }

  let reason = input.reason;
  for (const value of credentialValues.sort((a, b) => b.length - a.length)) {
    reason = reason.replaceAll(value, '[REDACTED]');
  }
  return containsEnterpriseSecretMaterial(reason) ? null : reason;
};

/** Always returns a safe reason string for mutation/audit paths (never the raw secret). */
const requireSanitizedIdentityReason = async (input: {
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}): Promise<string> => {
  const sanitized = await sanitizeIdentityReason(input);
  return sanitized ?? '[REDACTED]';
};

interface ExistingIdentityProviderReasonInput {
  providerId: string;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}

/**
 * Existing-provider mutations must always compare the reason with the stored
 * opaque client secret. Keeping providerId required here makes an unsafe
 * sanitization call impossible at those call sites.
 */
const requireSanitizedExistingIdentityReason = ({
  providerId,
  ...input
}: ExistingIdentityProviderReasonInput): Promise<string> =>
  requireSanitizedIdentityReason({ ...input, currentSecretTargetId: providerId });

const assertIdentityDangerousReauth = async (input: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
  targetId: string;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: input.authenticatedAt,
    authMethod: input.authMethod,
    serverDB: input.serverDB,
    denied: {
      action: input.action,
      actorUserId: input.actorUserId,
      resolveDeniedReason: () => sanitizeIdentityReason(input),
      targetId: input.targetId,
      targetType: 'identity_provider',
    },
  });

const assertExistingIdentityDangerousReauth = async (
  input: Omit<
    Parameters<typeof assertIdentityDangerousReauth>[0],
    'currentSecretTargetId' | 'targetId'
  > & { providerId: string },
) =>
  assertIdentityDangerousReauth({
    ...input,
    currentSecretTargetId: input.providerId,
    targetId: input.providerId,
  });

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
      const replacementSecrets = input.secret.operation === 'replace' ? [input.secret.value] : [];
      if (identitySecretMutationRequiresReauth(input.secret)) {
        await assertIdentityDangerousReauth({
          action: 'admin.identityProviders.create',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          currentSecretTargetId: null,
          reason: input.reason,
          replacementSecrets,
          serverDB: ctx.serverDB,
          targetId: input.providerKey,
        });
      }
      const reason = await requireSanitizedIdentityReason({
        currentSecretTargetId: null,
        reason: input.reason,
        replacementSecrets,
        serverDB: ctx.serverDB,
      });
      return execute(() =>
        ctx.getIdentityProviderRuntime().admin.create(ctx.userId!, { ...input, reason }),
      );
    }),

  delete: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_DELETE))
    .input(adminIdentityProviderDeleteInputSchema)
    .output(adminIdentityProviderDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertExistingIdentityDangerousReauth({
        action: 'admin.identityProviders.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const reason = await requireSanitizedExistingIdentityReason({
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      return execute(() =>
        ctx.getIdentityProviderRuntime().admin.delete(ctx.userId!, { ...input, reason }),
      );
    }),

  disable: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderDisableInputSchema)
    .output(adminIdentityProviderDisableOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertExistingIdentityDangerousReauth({
        action: 'admin.identityProviders.disable',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const reason = await requireSanitizedExistingIdentityReason({
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      return execute(async () =>
        toPublicIdentityProviderDraft(
          await new IdentityProviderPublicationService(ctx.serverDB).disable(ctx.userId!, {
            ...input,
            reason,
          }),
        ),
      );
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
      await assertExistingIdentityDangerousReauth({
        action: 'admin.identityProviders.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const reason = await requireSanitizedExistingIdentityReason({
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      return execute(async () =>
        toPublicIdentityProviderDraft(
          await new IdentityProviderPublicationService(ctx.serverDB).publish(ctx.userId!, {
            ...input,
            reason,
          }),
        ),
      );
    }),

  rollback: identityProviderProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH))
    .input(adminIdentityProviderRollbackInputSchema)
    .output(adminIdentityProviderRollbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertExistingIdentityDangerousReauth({
        action: 'admin.identityProviders.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      const reason = await requireSanitizedExistingIdentityReason({
        providerId: input.id,
        reason: input.reason,
        serverDB: ctx.serverDB,
      });
      return execute(async () =>
        toPublicIdentityProviderDraft(
          await new IdentityProviderPublicationService(ctx.serverDB).rollback(ctx.userId!, {
            ...input,
            reason,
          }),
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
      const replacementSecrets = input.secret.operation === 'replace' ? [input.secret.value] : [];
      if (identitySecretMutationRequiresReauth(input.secret)) {
        await assertExistingIdentityDangerousReauth({
          action: 'admin.identityProviders.update',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          providerId: input.id,
          reason: input.reason,
          replacementSecrets,
          serverDB: ctx.serverDB,
        });
      }
      const reason = await requireSanitizedExistingIdentityReason({
        providerId: input.id,
        reason: input.reason,
        replacementSecrets,
        serverDB: ctx.serverDB,
      });
      return execute(() =>
        ctx.getIdentityProviderRuntime().admin.update(ctx.userId!, { ...input, reason }),
      );
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
