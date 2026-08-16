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
  NO_REASON_AUDIT_PLACEHOLDER,
} from '../../contracts/identityProviders';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { IdentityProviderPublicationService } from '../../services/identityProvider/publicationService';
import { execute } from './identityProviderErrorMapping';
import {
  assertExistingIdentityDangerousReauth,
  assertIdentityDangerousReauth,
  identitySecretMutationRequiresReauth,
  requireSanitizedExistingIdentityReason,
  requireSanitizedIdentityReason,
} from './identityProviderReason';
import {
  createAdminIdentityProviderRuntime,
  isIdentityProviderFeatureEnabled,
} from './identityProvidersSupport';

export { identitySecretMutationRequiresReauth } from './identityProviderReason';

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
          reason: input.reason ?? NO_REASON_AUDIT_PLACEHOLDER,
          replacementSecrets,
          serverDB: ctx.serverDB,
          targetId: input.providerKey,
        });
      }
      // Saving a draft does not collect a reason (see optionalReasonSchema); only a supplied
      // one needs sanitizing against the secret being written.
      const reason = input.reason
        ? await requireSanitizedIdentityReason({
            currentSecretTargetId: null,
            reason: input.reason,
            replacementSecrets,
            serverDB: ctx.serverDB,
          })
        : NO_REASON_AUDIT_PLACEHOLDER;
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
        ctx
          .getIdentityProviderRuntime()
          .admin.discoverIssuer(ctx.userId!, input.issuer, input.type),
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
          reason: input.reason ?? NO_REASON_AUDIT_PLACEHOLDER,
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
          reason: input.reason ?? NO_REASON_AUDIT_PLACEHOLDER,
          replacementSecrets,
          serverDB: ctx.serverDB,
        });
      }
      const reason = input.reason
        ? await requireSanitizedExistingIdentityReason({
            providerId: input.id,
            reason: input.reason,
            replacementSecrets,
            serverDB: ctx.serverDB,
          })
        : NO_REASON_AUDIT_PLACEHOLDER;
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
