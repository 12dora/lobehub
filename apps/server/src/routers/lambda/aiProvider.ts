import { isOfficialProvider, OFFICIAL_PROVIDER_DISABLE_ERROR } from '@lobechat/business-const';
import { RequestTrigger } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AiProviderModel } from '@/database/models/aiProvider';
import { UserModel } from '@/database/models/user';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import {
  getEmptyAiProviderRuntimeState,
  personalModelOverlayKey,
  recordAiCatalogShadowComparison,
  resolveAiCatalogRuntimeState,
} from '@/server/enterprise/services/aiCatalog';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { type AiProviderDetailItem, type AiProviderRuntimeState } from '@/types/aiProvider';
import {
  CreateAiProviderSchema,
  UpdateAiProviderConfigSchema,
  UpdateAiProviderSchema,
} from '@/types/aiProvider';
import { type ProviderConfig } from '@/types/user/settings';

const MAX_AI_CATALOG_SHADOW_PROVIDERS = 20;
const MAX_AI_CATALOG_SHADOW_MODELS_PER_PROVIDER = 200;

const aiProviderProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;

  const { aiProvider } = await getServerGlobalConfig();

  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  return opts.next({
    ctx: {
      aiInfraRepos: new AiInfraRepos(
        ctx.serverDB,
        ctx.userId,
        aiProvider as Record<string, ProviderConfig>,
        ctx.workspaceId ?? undefined,
      ),
      aiProviderModel: new AiProviderModel(ctx.serverDB, ctx.userId, ctx.workspaceId ?? undefined),
      gateKeeper,
      userModel: new UserModel(ctx.serverDB, ctx.userId),
    },
  });
});

export const aiProviderRouter = router({
  checkProviderConnectivity: aiProviderProcedure
    .use(withScopedPermission('ai_provider:update'))
    .use(withManagedResourceGuard('aiProvider.checkProviderConnectivity'))
    .input(
      z.object({
        id: z.string(),
        model: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get the provider detail to find checkModel
      const detail = await ctx.aiInfraRepos.getAiProviderDetail(
        input.id,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );

      const model = input.model || detail?.checkModel;
      if (!model) {
        return { error: 'No check model configured. Use --model to specify one.', ok: false };
      }

      try {
        const modelRuntime = await initModelRuntimeFromDB(
          ctx.serverDB,
          ctx.userId,
          input.id,
          ctx.workspaceId ?? undefined,
        );

        const response = await modelRuntime.chat(
          {
            messages: [{ content: 'Hi', role: 'user' }],
            model,
            stream: false,
            temperature: 0,
          },
          {
            metadata: { trigger: RequestTrigger.Api },
          },
        );

        // If we get a response without error, connectivity is ok
        if (response.ok) {
          return { model, ok: true };
        }

        const errorBody = await response.text();
        return { error: errorBody, model, ok: false, status: response.status };
      } catch (error: any) {
        const errorType = error.errorType || error.type;
        const msg =
          errorType ||
          (typeof error === 'string'
            ? error
            : error.message || (typeof error === 'object' ? JSON.stringify(error) : String(error)));
        return { error: msg, model, ok: false };
      }
    }),

  createAiProvider: aiProviderProcedure
    .use(withScopedPermission('ai_provider:create'))
    .use(withManagedResourceGuard('aiProvider.createAiProvider'))
    .input(CreateAiProviderSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const data = await ctx.aiProviderModel.create(input, ctx.gateKeeper.encrypt);
        return data?.id;
      } catch (error: any) {
        const pgErrorCode = error?.cause?.cause?.code || error?.cause?.code || error?.code;
        if (pgErrorCode === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Provider "${input.id}" already exists`,
          });
        }
        throw error;
      }
    }),

  getAiProviderById: aiProviderProcedure
    .input(z.object({ id: z.string() }))

    .query(async ({ input, ctx }): Promise<AiProviderDetailItem | undefined> => {
      return ctx.aiInfraRepos.getAiProviderDetail(input.id, KeyVaultsGateKeeper.getUserKeyVaults);
    }),

  getAiProviderList: aiProviderProcedure.query(async ({ ctx }) => {
    return await ctx.aiInfraRepos.getAiProviderList();
  }),

  getAiProviderRuntimeState: aiProviderProcedure
    .input(z.object({ isLogin: z.boolean().optional() }))
    .query(async ({ ctx }): Promise<AiProviderRuntimeState> => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      let upstreamState: AiProviderRuntimeState;
      if (flags.ENABLE_PLATFORM_MANAGED_AI) {
        // Shadow comparison needs only provider/model metadata. Never decrypt user vaults here.
        const providers = (await ctx.aiInfraRepos.getAiProviderList())
          .filter((provider) => provider.enabled)
          .slice(0, MAX_AI_CATALOG_SHADOW_PROVIDERS);
        const models = (
          await Promise.all(
            providers.map(async (provider) =>
              (await ctx.aiInfraRepos.getAiProviderModelList(provider.id, { enabled: true }))
                .slice(0, MAX_AI_CATALOG_SHADOW_MODELS_PER_PROVIDER)
                .map((model) => ({
                  ...model,
                  abilities: model.abilities ?? {},
                  enabled: true,
                  providerId: provider.id,
                })),
            ),
          )
        ).flat();
        const providerMetadata = providers.map(({ id, name, source }) => ({ id, name, source }));
        const hasType = (providerId: string, type: string) =>
          models.some((model) => model.providerId === providerId && model.type === type);
        upstreamState = {
          ...getEmptyAiProviderRuntimeState(),
          enabledAiModels: models,
          enabledAiProviders: providerMetadata,
          enabledChatAiProviders: providerMetadata.filter((provider) =>
            hasType(provider.id, 'chat'),
          ),
          enabledImageAiProviders: providerMetadata.filter((provider) =>
            hasType(provider.id, 'image'),
          ),
          enabledVideoAiProviders: providerMetadata.filter((provider) =>
            hasType(provider.id, 'video'),
          ),
        };
      } else {
        upstreamState = await ctx.aiInfraRepos.getAiProviderRuntimeState(
          KeyVaultsGateKeeper.getUserKeyVaults,
        );
      }
      // Personal hide-overrides: a user may drop an admin-published model from THEIR picker.
      // View-only — the execution allowlist stays published-only, so a hidden model still runs
      // when something asks for it by name.
      const hiddenModelKeys = flags.ENABLE_PLATFORM_MANAGED_AI
        ? new Set(
            (await ctx.aiInfraRepos.aiModelModel.getAllModels())
              .filter((model) => model.enabled === false)
              .map((model) => personalModelOverlayKey(model.providerId, model.id)),
          )
        : undefined;
      const effectiveState = await resolveAiCatalogRuntimeState({
        db: ctx.serverDB,
        flags,
        hiddenModelKeys,
        upstreamState,
      });
      if (effectiveState !== upstreamState) {
        recordAiCatalogShadowComparison(upstreamState, effectiveState);
      }
      return effectiveState;
    }),

  removeAiProvider: aiProviderProcedure
    .use(withScopedPermission('ai_provider:delete'))
    .use(withManagedResourceGuard('aiProvider.removeAiProvider'))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.aiProviderModel.delete(input.id);
    }),

  toggleProviderEnabled: aiProviderProcedure
    .use(withScopedPermission('ai_provider:update'))
    .use(withManagedResourceGuard('aiProvider.toggleProviderEnabled'))
    .input(
      z.object({
        enabled: z.boolean(),
        id: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (isOfficialProvider(input.id) && input.enabled === false) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: OFFICIAL_PROVIDER_DISABLE_ERROR,
        });
      }

      return ctx.aiProviderModel.toggleProviderEnabled(input.id, input.enabled);
    }),

  updateAiProvider: aiProviderProcedure
    .use(withScopedPermission('ai_provider:update'))
    .use(withManagedResourceGuard('aiProvider.updateAiProvider'))
    .input(
      z.object({
        id: z.string(),
        value: UpdateAiProviderSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.aiProviderModel.update(input.id, input.value);
    }),

  updateAiProviderConfig: aiProviderProcedure
    .use(withScopedPermission('ai_provider:update'))
    .use(withManagedResourceGuard('aiProvider.updateAiProviderConfig'))
    .input(
      z.object({
        id: z.string(),
        value: UpdateAiProviderConfigSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.aiProviderModel.updateConfig(
        input.id,
        input.value,
        ctx.gateKeeper.encrypt,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );
    }),

  updateAiProviderOrder: aiProviderProcedure
    .use(withScopedPermission('ai_provider:update'))
    .use(withManagedResourceGuard('aiProvider.updateAiProviderOrder'))
    .input(
      z.object({
        sortMap: z.array(
          z.object({
            id: z.string(),
            sort: z.number(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.aiProviderModel.updateOrder(input.sortMap);
    }),
});

export type AiProviderRouter = typeof aiProviderRouter;
