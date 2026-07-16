import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAiCatalogModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAiModelCreateInputSchema,
  adminAiModelDeleteInputSchema,
  adminAiModelDeleteOutputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiModelMutationOutputSchema,
  adminAiModelReorderInputSchema,
  adminAiModelReorderOutputSchema,
  adminAiModelUpdateInputSchema,
  adminAiProviderArchiveInputSchema,
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderMutationOutputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
  adminAiProviderRevisionOutputSchema,
  adminAiProviderRollbackInputSchema,
  adminAiProviderTestInputSchema,
  adminAiProviderUpdateDraftInputSchema,
  aiConnectionTestResultSchema,
} from '../../contracts/aiCatalog';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

export const adminAiProvidersRouter = router({
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

  createDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE))
    .input(adminAiProviderCreateDraftInputSchema)
    .output(adminAiProviderMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).createProviderDraft(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE))
    .input(adminAiProviderGetInputSchema)
    .output(adminAiProviderGetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createService(ctx.serverDB).getDetail(input.id);
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
      try {
        return await createService(ctx.serverDB).updateProviderDraft(ctx.userId!, input);
      } catch (error) {
        return mapServiceError(error);
      }
    }),
});

export const adminAiModelsRouter = router({
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
