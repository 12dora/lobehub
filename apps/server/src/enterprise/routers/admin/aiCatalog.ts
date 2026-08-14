import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAiCatalogModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAiModelApplyImmediateInputSchema,
  adminAiModelApplyImmediateOutputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiProviderApplyImmediateInputSchema,
  adminAiProviderApplyImmediateOutputSchema,
  adminAiProviderDeleteInputSchema,
  adminAiProviderDeleteOutputSchema,
  adminAiProviderGetBatchInputSchema,
  adminAiProviderGetBatchOutputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
  adminAiProviderTestInputSchema,
  aiConnectionTestResultSchema,
} from '../../contracts/aiCatalog';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withCompoundPlatformPermission,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const adminAiProvidersRouter = router({
  /**
   * The only provider write: apply the change and publish it immediately, always.
   * A failure throws (client toasts it) — nothing is ever left saved-but-not-live.
   * Requires UPDATE+PUBLISH (or CREATE+PUBLISH for create mode). Rate-limit: 1 unit.
   */
  applyImmediate: adminBase
    .use(
      withCompoundPlatformPermission({
        fixed: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH],
        select: (raw) => {
          const mode = (raw as { mode?: string } | null)?.mode;
          return mode === 'create'
            ? PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE
            : PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE;
        },
        selectable: [
          PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
          PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
        ],
      }),
    )
    .input(adminAiProviderApplyImmediateInputSchema)
    .output(adminAiProviderApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
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
   * True hard delete: models, revision history and the provider row (secrets cascade).
   * After this the provider is as if it had never been platform-managed — runtime resolves
   * NOT_FOUND and falls back to the user's own BYOK configuration.
   */
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

  /**
   * Read-only publication history. Not a draft/publish affordance: the agent dependency
   * editor reads the published revision checksum from here to pin a model dependency.
   */
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
});

export const adminAiModelsRouter = router({
  /**
   * The only model write: mutate model rows then publish the parent provider immediately.
   * A failure throws — model edits never linger as an unpublished draft.
   * Combination rule (rate-limit: 1 unit):
   * - fixed: AI_PROVIDER_PUBLISH + AI_MODEL_PUBLISH
   * - selectable: CREATE / UPDATE / DELETE from input.operation
   */
  applyImmediate: adminBase
    .use(
      withCompoundPlatformPermission({
        fixed: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH, PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH],
        select: (raw) => {
          const operation = (raw as { operation?: string } | null)?.operation;
          if (operation === 'create') return PLATFORM_PERMISSIONS.AI_MODEL_CREATE;
          if (operation === 'delete' || operation === 'clear') {
            return PLATFORM_PERMISSIONS.AI_MODEL_DELETE;
          }
          return PLATFORM_PERMISSIONS.AI_MODEL_UPDATE;
        },
        selectable: [
          PLATFORM_PERMISSIONS.AI_MODEL_CREATE,
          PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
          PLATFORM_PERMISSIONS.AI_MODEL_DELETE,
        ],
      }),
    )
    .input(adminAiModelApplyImmediateInputSchema)
    .output(adminAiModelApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // The publish step requires reauth (aligned with admin.aiProviders.applyImmediate).
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
        return await createService(ctx.serverDB).applyModelImmediate(ctx.userId!, input, {
          // The compound gate can only classify the *declared* operation. `batchUpdate`
          // decides insert-vs-update from database state, so the CREATE grant travels into
          // the service and is enforced where that decision is made.
          allowModelCreate: ctx.platformAuth.permissions.includes(
            PLATFORM_PERMISSIONS.AI_MODEL_CREATE,
          ),
        });
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
});
