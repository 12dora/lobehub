import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { checksumPayload, PlatformAiCatalogModel } from '@/database/models/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
} from '../../contracts/aiCatalog';
import { withActiveUser } from '../../guards/activeUser';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';

const adminBase = authedProcedure.use(serverDatabase).use(withActiveUser());

export const adminAiProvidersRouter = router({
  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE))
    .input(adminAiProviderGetInputSchema)
    .output(adminAiProviderGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const provider = await new PlatformAiCatalogModel(ctx.serverDB).getProvider(input.id);
      if (!provider) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }
      return {
        baseRevision: provider.revision,
        draft: provider,
        draftToken: checksumPayload({ draft: provider, revision: provider.revision }),
        published: null,
      };
    }),

  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderListInputSchema)
    .output(adminAiProviderListOutputSchema)
    .query(async ({ ctx, input }) => new PlatformAiCatalogModel(ctx.serverDB).listProviders(input)),
});

export const adminAiModelsRouter = router({
  dependents: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_MODEL_READ))
    .input(adminAiModelDependentsInputSchema)
    .output(adminAiModelDependentsOutputSchema)
    .query(() => ({ items: [] })),

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
