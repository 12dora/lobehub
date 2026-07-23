import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAiCatalogModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAiModelApplyImmediateInputSchema,
  adminAiModelApplyImmediateOutputSchema,
  adminAiModelCreateInputSchema,
  adminAiModelCreateTargetListInputSchema,
  adminAiModelCreateTargetListOutputSchema,
  adminAiModelDeleteInputSchema,
  adminAiModelDeleteOutputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelDraftContextInputSchema,
  adminAiModelDraftContextOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiModelMutationOutputSchema,
  adminAiModelReorderInputSchema,
  adminAiModelReorderOutputSchema,
  adminAiModelUpdateInputSchema,
  adminAiProviderApplyImmediateInputSchema,
  adminAiProviderApplyImmediateOutputSchema,
  adminAiProviderArchiveInputSchema,
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderDeleteInputSchema,
  adminAiProviderDeleteOutputSchema,
  adminAiProviderGetBatchInputSchema,
  adminAiProviderGetBatchOutputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderMutationOutputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderPublishNowInputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
  adminAiProviderRevisionOutputSchema,
  adminAiProviderRollbackInputSchema,
  adminAiProviderTestInputSchema,
  adminAiProviderUpdateDraftInputSchema,
  aiConnectionTestResultSchema,
} from '../../contracts/aiCatalog';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  aiSecretMutationRequiresReauth,
  assertDangerousReauth,
  createService,
  mapServiceError,
} from './aiCatalogSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const adminAiProvidersRouter = router({
  /**
   * Create/update draft then publish in one procedure (admin settings UI parity).
   * Requires UPDATE+PUBLISH (or CREATE+PUBLISH for create mode). Rate-limit: 1 unit.
   */
  applyImmediate: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH))
    .input(adminAiProviderApplyImmediateInputSchema)
    .output(adminAiProviderApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // CREATE+PUBLISH or UPDATE+PUBLISH (PUBLISH already enforced by middleware).
      const required =
        input.mode === 'create'
          ? PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE
          : PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE;
      const perms = (ctx as { platformAuth?: { permissions: string[] } }).platformAuth?.permissions;
      if (!perms?.includes(required)) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
          details: { permission: required },
          httpCode: 'FORBIDDEN',
          message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        });
      }
      // Publish always requires reauth; secret replace/clear also covered by the same gate.
      await assertDangerousReauth({
        action: 'admin.aiProviders.applyImmediate',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        replacementSecrets:
          input.secret?.operation === 'replace' || input.secret?.operation === 'merge'
            ? [input.secret.value]
            : undefined,
        serverDB: ctx.serverDB,
        targetId: input.mode === 'create' ? input.providerKey : input.id,
      });
      try {
        return await createService(ctx.serverDB).applyProviderImmediate(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  /**
   * Banner "retry publish": re-run connection test when revision===0, then publish.
   * Same guard combo as applyImmediate (PUBLISH + reauth + rate-limit).
   */
  publishNow: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH))
    .input(adminAiProviderPublishNowInputSchema)
    .output(adminAiProviderApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.aiProviders.publishNow',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createService(ctx.serverDB).publishNow(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  archive: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE))
    .input(adminAiProviderArchiveInputSchema)
    .output(adminAiProviderRevisionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.aiProviders.archive',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createService(ctx.serverDB).archiveProvider(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  delete: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE))
    .input(adminAiProviderDeleteInputSchema)
    .output(adminAiProviderDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.aiProviders.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createService(ctx.serverDB).deleteProvider(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  createDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE))
    .input(adminAiProviderCreateDraftInputSchema)
    .output(adminAiProviderMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (aiSecretMutationRequiresReauth(input.secret)) {
        await assertDangerousReauth({
          action: 'admin.aiProviders.createDraft',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          existingSecretTargetId: null,
          reason: input.reason,
          replacementSecrets:
            input.secret?.operation === 'replace' || input.secret?.operation === 'merge'
              ? [input.secret.value]
              : [],
          serverDB: ctx.serverDB,
          targetId: input.providerKey,
        });
      }
      try {
        return await createService(ctx.serverDB).createProviderDraft(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderGetInputSchema)
    .output(adminAiProviderGetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getDetail(input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  /** Bulk detail (models included) — eliminates client N+1 for runtime state. */
  getBatch: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderGetBatchInputSchema)
    .output(adminAiProviderGetBatchOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getDetailsBatch(input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderListInputSchema)
    .output(adminAiProviderListOutputSchema)
    .query(async ({ ctx, input }) => new PlatformAiCatalogModel(ctx.serverDB).listProviders(input)),

  listRevisions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderRevisionHistoryInputSchema)
    .output(adminAiProviderRevisionHistoryOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).listRevisionHistory(input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  publish: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH))
    .input(adminAiProviderPublishInputSchema)
    .output(adminAiProviderRevisionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.aiProviders.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createService(ctx.serverDB).publishProvider(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  rollback: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH))
    .input(adminAiProviderRollbackInputSchema)
    .output(adminAiProviderRevisionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.aiProviders.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createService(ctx.serverDB).rollbackProvider(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  test: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_TEST))
    .input(adminAiProviderTestInputSchema)
    .output(aiConnectionTestResultSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).testProvider(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  updateDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE))
    .input(adminAiProviderUpdateDraftInputSchema)
    .output(adminAiProviderMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (aiSecretMutationRequiresReauth(input.secret)) {
        await assertDangerousReauth({
          action: 'admin.aiProviders.updateDraft',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          replacementSecrets:
            input.secret?.operation === 'replace' || input.secret?.operation === 'merge'
              ? [input.secret.value]
              : [],
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
      }
      try {
        return await createService(ctx.serverDB).updateProviderDraft(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),
});

export const adminAiModelsRouter = router({
  /**
   * Model draft mutation(s) + immediate parent-provider publish (admin UI parity).
   * Requires the operation's model permission + AI_PROVIDER_PUBLISH. Rate-limit: 1 unit.
   */
  applyImmediate: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH))
    .input(adminAiModelApplyImmediateInputSchema)
    .output(adminAiModelApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const opPermission =
        input.operation === 'create'
          ? PLATFORM_PERMISSIONS.AI_MODEL_CREATE
          : input.operation === 'delete' || input.operation === 'clear'
            ? PLATFORM_PERMISSIONS.AI_MODEL_DELETE
            : PLATFORM_PERMISSIONS.AI_MODEL_UPDATE;
      const perms = (ctx as { platformAuth?: { permissions: string[] } }).platformAuth?.permissions;
      if (!perms?.includes(opPermission)) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
          details: { permission: opPermission },
          httpCode: 'FORBIDDEN',
          message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        });
      }
      // Publish step requires reauth (aligned with admin.aiProviders.publish).
      await assertDangerousReauth({
        action: 'admin.aiModels.applyImmediate',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.providerId,
      });
      try {
        return await createService(ctx.serverDB).applyModelImmediate(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  create: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_CREATE))
    .input(adminAiModelCreateInputSchema)
    .output(adminAiModelMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).createModel(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  deleteFromDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_DELETE))
    .input(adminAiModelDeleteInputSchema)
    .output(adminAiModelDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).deleteModel(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  dependents: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_READ))
    .input(adminAiModelDependentsInputSchema)
    .output(adminAiModelDependentsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const items = await createService(ctx.serverDB).getDependents(input.providerId, input.id);
        return { items };
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  getCreateDraftContext: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_CREATE))
    .input(adminAiModelDraftContextInputSchema)
    .output(adminAiModelDraftContextOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getModelDraftContext(input.providerId);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  getDeleteDraftContext: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_DELETE))
    .input(adminAiModelDraftContextInputSchema)
    .output(adminAiModelDraftContextOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getModelDraftContext(input.providerId);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  getUpdateDraftContext: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_UPDATE))
    .input(adminAiModelDraftContextInputSchema)
    .output(adminAiModelDraftContextOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getModelDraftContext(input.providerId);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_READ))
    .input(adminAiModelListInputSchema)
    .output(adminAiModelListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await new PlatformAiCatalogModel(ctx.serverDB).listModels(input);
      } catch (error) {
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

  listCreateTargets: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_CREATE))
    .input(adminAiModelCreateTargetListInputSchema)
    .output(adminAiModelCreateTargetListOutputSchema)
    .query(async ({ ctx, input }) => createService(ctx.serverDB).listModelCreateTargets(input)),

  reorder: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_UPDATE))
    .input(adminAiModelReorderInputSchema)
    .output(adminAiModelReorderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).reorderModels(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  update: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_UPDATE))
    .input(adminAiModelUpdateInputSchema)
    .output(adminAiModelMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).updateModel(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),
});
