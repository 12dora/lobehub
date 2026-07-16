import { getComposioAppByIdentifier } from '@lobechat/const';
import type { ToolManifest } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getServerComposioAuthConfigId } from '@/config/composio';
import type { DecryptedConnector } from '@/database/models/connector';
import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { PluginModel } from '@/database/models/plugin';
import {
  type ComposioConnectorMetadata,
  type ConnectorMetadata,
  ConnectorSourceType,
  ConnectorStatus,
} from '@/database/schemas';
import { getComposioClient } from '@/libs/composio';
import { inferCrudType } from '@/libs/mcp/utils';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';

const composioCreateConnectionInputSchema = z
  .object({
    appSlug: z.string().min(1).max(128),
    identifier: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
  })
  .strict();

const composioUpdatePluginInputSchema = z
  .object({
    appSlug: z.string().min(1).max(128),
    authConfigId: z.string().min(1).max(256),
    connectedAccountId: z.string().min(1).max(256),
    identifier: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    redirectUrl: z.string().optional(),
    status: z.literal('ACTIVE'),
  })
  .strict();

const composioGetConnectionInputSchema = z
  .object({ identifier: z.string().min(1).max(128) })
  .strict();

const composioBindingMetadataSchema = z
  .object({
    appSlug: z.string().min(1),
    authConfigId: z.string().min(1),
    connectedAccountId: z.string().min(1),
    redirectUrl: z.string().optional(),
    status: z.string().min(1),
  })
  .passthrough();

const composioConnectionRequestSchema = z
  .object({ id: z.string().min(1), redirectUrl: z.string().min(1) })
  .passthrough();

const composioRemoteAccountSchema = z
  .object({
    authConfig: z.object({ id: z.string().min(1) }).passthrough(),
    id: z.string().min(1),
    status: z.enum([
      'ACTIVE',
      'EXPIRED',
      'FAILED',
      'INACTIVE',
      'INITIALIZING',
      'INITIATED',
      'REVOKED',
    ]),
    toolkit: z.object({ slug: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const composioOwnedAccountListSchema = z
  .object({
    items: z.array(composioRemoteAccountSchema),
    nextCursor: z.string().nullish(),
  })
  .passthrough();

const composioServerToolSchema = z
  .object({
    description: z.string().optional(),
    inputParameters: z.record(z.unknown()).optional(),
    inputSchema: z.record(z.unknown()).optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
  })
  .passthrough();

const composioProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const client = getComposioClient();
  const pluginModel = new PluginModel(opts.ctx.serverDB, opts.ctx.userId);
  // Personal-scoped (no workspaceId/gateKeeper), matching PluginModel above:
  // Composio connections are personal today, and the runtime reads them back
  // with the same scoping (ComposioService is constructed with { db, userId }).
  const connectorModel = new ConnectorModel(opts.ctx.serverDB, opts.ctx.userId);
  const connectorToolModel = new ConnectorToolModel(opts.ctx.serverDB, opts.ctx.userId);

  return opts.next({
    ctx: { ...opts.ctx, composioClient: client, connectorModel, connectorToolModel, pluginModel },
  });
});

type ComposioToolInput = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
};

type ComposioCreateConnectionInput = z.infer<typeof composioCreateConnectionInputSchema>;
type ComposioUpdatePluginInput = z.infer<typeof composioUpdatePluginInputSchema>;

interface ComposioBindingModels {
  connectorModel: ConnectorModel;
  pluginModel: PluginModel;
}

interface ComposioRemoteOwnerContext {
  composioClient: ReturnType<typeof getComposioClient>;
  userId: string;
}

const getCanonicalComposioApp = (input: { appSlug: string; identifier: string; label: string }) => {
  const app = getComposioAppByIdentifier(input.identifier);
  if (!app || app.appSlug !== input.appSlug || app.label !== input.label) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Composio catalog selection' });
  }

  return app;
};

const getComposioBindingMetadata = (value: unknown): ComposioConnectorMetadata | undefined => {
  const parsed = composioBindingMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const resolveOwnedComposioBindingState = async (
  models: ComposioBindingModels,
  identifier: string,
  options: { requireBinding: boolean },
) => {
  const [connectorRows, plugin] = await Promise.all([
    models.connectorModel.queryByIdentifiers([identifier]),
    models.pluginModel.findById(identifier),
  ]);
  const connector = connectorRows[0];
  const connectorBinding = getComposioBindingMetadata(connector?.metadata?.composio);
  const pluginBinding = getComposioBindingMetadata(plugin?.customParams?.composio);

  if (
    (connector &&
      (connector.sourceType !== ConnectorSourceType.marketplace || !connectorBinding)) ||
    (plugin && (plugin.source !== 'composio' || !pluginBinding))
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Identifier is already used by a non-Composio definition',
    });
  }

  if (
    connectorBinding &&
    pluginBinding &&
    (connectorBinding.appSlug !== pluginBinding.appSlug ||
      connectorBinding.authConfigId !== pluginBinding.authConfigId ||
      connectorBinding.connectedAccountId !== pluginBinding.connectedAccountId)
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Composio binding projections disagree' });
  }

  const binding = connectorBinding ?? pluginBinding;
  if (options.requireBinding && !binding) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Composio connection not found' });
  }

  return { binding, connector, plugin };
};

const resolveOwnedCatalogBinding = async (models: ComposioBindingModels, identifier: string) => {
  const app = getComposioAppByIdentifier(identifier);
  if (!app) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Composio connection not found' });
  }
  const state = await resolveOwnedComposioBindingState(models, identifier, {
    requireBinding: true,
  });
  const { binding } = state;
  if (!binding) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Composio connection not found' });
  }
  if (binding.appSlug.toLowerCase() !== app.appSlug.toLowerCase()) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Composio binding toolkit mismatch' });
  }

  return { app, binding, state };
};

const resolveRemoteOwnedComposioAccount = async (
  ctx: ComposioRemoteOwnerContext,
  params: { appSlug: string; authConfigId: string; connectedAccountId: string },
) => {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    const response = composioOwnedAccountListSchema.safeParse(
      await ctx.composioClient.connectedAccounts.list({
        authConfigIds: [params.authConfigId],
        cursor,
        limit: 100,
        toolkitSlugs: [params.appSlug],
        userIds: [ctx.userId],
      }),
    );
    if (!response.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Invalid Composio owner lookup response',
      });
    }

    const account = response.data.items.find((item) => item.id === params.connectedAccountId);
    if (account) {
      if (
        account.authConfig.id !== params.authConfigId ||
        account.toolkit.slug.toLowerCase() !== params.appSlug.toLowerCase()
      ) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Composio remote binding mismatch' });
      }
      return account;
    }

    cursor = response.data.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Composio owner lookup cursor repeated',
      });
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  throw new TRPCError({ code: 'FORBIDDEN', message: 'Composio binding owner mismatch' });
};

const assertCreateBindingLifecycle = async (
  input: ComposioCreateConnectionInput,
  models: ComposioBindingModels,
) => {
  const app = getCanonicalComposioApp(input);
  const state = await resolveOwnedComposioBindingState(models, input.identifier, {
    requireBinding: false,
  });
  if (state.binding && state.binding.appSlug !== app.appSlug) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Composio binding toolkit mismatch' });
  }

  return { app, state };
};

const assertUpdateBindingLifecycle = async (
  input: ComposioUpdatePluginInput,
  models: ComposioBindingModels,
) => {
  const app = getCanonicalComposioApp(input);
  const { binding, state } = await resolveOwnedCatalogBinding(models, input.identifier);
  if (
    binding.appSlug !== app.appSlug ||
    binding.authConfigId !== input.authConfigId ||
    binding.connectedAccountId !== input.connectedAccountId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Composio binding mismatch' });
  }

  return { app, binding, state };
};

const getComposioGuardModels = (ctx: unknown): ComposioBindingModels =>
  ctx as ComposioBindingModels;

const isManagedComposioCreateBindingInput = async (input: unknown, ctx: unknown) => {
  const parsed = composioCreateConnectionInputSchema.safeParse(input);
  if (!parsed.success) return false;

  try {
    await assertCreateBindingLifecycle(parsed.data, getComposioGuardModels(ctx));
    return true;
  } catch {
    return false;
  }
};

const isManagedComposioUpdateBindingInput = async (input: unknown, ctx: unknown) => {
  const parsed = composioUpdatePluginInputSchema.safeParse(input);
  if (!parsed.success) return false;

  try {
    await assertUpdateBindingLifecycle(parsed.data, getComposioGuardModels(ctx));
    return true;
  } catch {
    return false;
  }
};

const mapTrustedComposioTools = (response: unknown): ComposioToolInput[] => {
  const wrapped = z
    .object({ items: z.array(z.unknown()) })
    .passthrough()
    .safeParse(response);
  const items = wrapped.success ? wrapped.data.items : Array.isArray(response) ? response : [];
  const tools = new Map<string, ComposioToolInput>();

  for (const item of items) {
    const parsed = composioServerToolSchema.safeParse(item);
    if (!parsed.success) continue;
    const name = parsed.data.slug || parsed.data.name;
    if (!name) continue;
    tools.set(name, {
      description: parsed.data.description,
      inputSchema: parsed.data.inputParameters ?? parsed.data.inputSchema,
      name,
    });
  }

  return [...tools.values()];
};

/**
 * Dual-write helper: mirror a Composio connection into `user_connectors`
 * (+ `user_connector_tools`) so the runtime can resolve it without touching the
 * plugin table. Idempotent on (userId, identifier). The plugin-table write is
 * kept by the callers for backward compatibility; this only adds the connector
 * projection so new connections run off metadata while old ones fall back.
 */
async function upsertComposioConnector(
  connectorModel: ConnectorModel,
  connectorToolModel: ConnectorToolModel,
  params: {
    composio: ComposioConnectorMetadata;
    identifier: string;
    label: string;
    /**
     * When true, the connector's tool set is REPLACED by `tools`: rows missing
     * from the latest list are deleted. Use for the authoritative refresh
     * (updateComposioPlugin), where the runtime manifest is built from these
     * rows, so a shrunk/emptied tool list must not leave stale tools advertised.
     * Leave false for the pre-auth seed (createConnection), whose tool list may
     * be incomplete or empty before authorization.
     */
    replaceTools?: boolean;
    tools?: ComposioToolInput[];
  },
): Promise<void> {
  const metadata: ConnectorMetadata = {
    avatar: '🔌',
    composio: params.composio,
    description: `Composio: ${params.label}`,
  };

  const status =
    params.composio.status === 'ACTIVE'
      ? ConnectorStatus.connected
      : params.composio.status === 'FAILED'
        ? ConnectorStatus.error
        : ConnectorStatus.disconnected;

  const [existing] = await connectorModel.queryByIdentifiers([params.identifier]);
  let connectorId: string;
  if (existing) {
    await connectorModel.update(existing.id, {
      metadata,
      name: params.label,
      sourceType: ConnectorSourceType.marketplace,
      status,
    });
    connectorId = existing.id;
  } else {
    const created = await connectorModel.create({
      identifier: params.identifier,
      isEnabled: true,
      metadata,
      name: params.label,
      sourceType: ConnectorSourceType.marketplace,
      status,
    });
    connectorId = created.id;
  }

  if (params.tools) {
    if (params.tools.length > 0) {
      await connectorToolModel.upsertMany(
        connectorId,
        params.tools.map((t) => ({
          crudType: inferCrudType(t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          toolName: t.name,
        })),
      );
    }

    // Replace (not merge) so tools removed upstream stop being advertised.
    if (params.replaceTools) {
      await connectorToolModel.deleteToolsNotIn(
        connectorId,
        params.tools.map((t) => t.name),
      );
    }
  }
}

/** Remove the connector projection for a Composio identifier (tools cascade). */
async function deleteComposioConnector(
  connectorModel: ConnectorModel,
  identifier: string,
): Promise<void> {
  const [existing] = await connectorModel.queryByIdentifiers([identifier]);
  if (existing) await connectorModel.delete(existing.id);
}

const resolveOwnedComposioConnector = async (
  connectorModel: ConnectorModel,
  input: { connectorId?: string; identifier?: string },
): Promise<{ binding: ComposioConnectorMetadata; connector: DecryptedConnector }> => {
  const connector = input.connectorId
    ? await connectorModel.findById(input.connectorId)
    : input.identifier
      ? (await connectorModel.queryByIdentifiers([input.identifier]))[0]
      : undefined;

  const binding = getComposioBindingMetadata(connector?.metadata?.composio);
  if (
    !connector ||
    (input.identifier !== undefined && connector.identifier !== input.identifier) ||
    !binding
  ) {
    // Deliberately use one response for absent, foreign and malformed rows so
    // callers cannot probe another user's connector/binding relationship.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Composio connection not found' });
  }

  return { binding, connector };
};

export const composioRouter = router({
  createConnection: composioProcedure
    .use(
      withManagedResourceGuard('composio.createConnection', {
        isExemptInput: isManagedComposioCreateBindingInput,
      }),
    )
    .input(composioCreateConnectionInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { app, state } = await assertCreateBindingLifecycle(input, ctx);
      const { appSlug, identifier, label } = app;
      const { userId } = ctx;

      if (state.binding) {
        await resolveRemoteOwnedComposioAccount(ctx, state.binding);
      }

      const callbackUrl = `${process.env.APP_URL || process.env.NEXTAUTH_URL || ''}/api/composio/oauth/callback`;

      // Prefer a pre-configured auth config (e.g. a custom/white-label config
      // created in the Composio dashboard), pinned per toolkit via env. Falls
      // back to discovering an existing config for this toolkit, and finally to
      // auto-creating a Composio-managed one.
      let authConfigId = getServerComposioAuthConfigId(identifier);
      if (!authConfigId) {
        const authConfigs = await (ctx.composioClient.authConfigs as any).list();
        let authConfig = authConfigs?.items?.find(
          (c: any) => c.toolkit?.slug?.toLowerCase() === appSlug.toLowerCase(),
        );
        if (!authConfig) {
          authConfig = await (ctx.composioClient.authConfigs as any).create(appSlug, {
            name: appSlug,
            type: 'use_composio_managed_auth',
          });
        }
        authConfigId = authConfig.id;
      }

      if (!authConfigId) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to resolve a Composio auth config for "${appSlug}".`,
        });
      }

      // Composio-managed OAuth auth configs no longer support `initiate`; use
      // `link` (POST /api/v3/connected_accounts/link) to get the redirect URL.
      const connReq = composioConnectionRequestSchema.parse(
        await (ctx.composioClient.connectedAccounts as any).link(userId, authConfigId, {
          callbackUrl,
        }),
      );

      let tools: ComposioToolInput[] = [];
      try {
        const toolsResp = await (ctx.composioClient.tools as any).getRawComposioTools({
          toolkits: [appSlug],
        });
        tools = mapTrustedComposioTools(toolsResp);
      } catch (error) {
        // Tools may not be available before auth; ACTIVE sync fetches them again.
        console.error('[composio:createConnection] pre-auth tool fetch failed', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }

      const manifest: ToolManifest = {
        api: tools.map((tool) => ({
          description: tool.description || '',
          name: tool.name,
          parameters: tool.inputSchema || { properties: {}, type: 'object' },
        })),
        identifier,
        meta: {
          avatar: '🔌',
          description: `Composio: ${label}`,
          title: label,
        },
        type: 'default',
      };

      await ctx.pluginModel.create({
        customParams: {
          composio: {
            appSlug,
            authConfigId,
            connectedAccountId: connReq.id,
            redirectUrl: connReq.redirectUrl,
            status: 'PENDING',
          },
        },
        identifier,
        manifest,
        source: 'composio',
        type: 'plugin',
      });

      // Dual-write: mirror the (pending) connection into user_connectors so the
      // runtime can resolve it off metadata once it goes ACTIVE. Tools sync on
      // updateComposioPlugin; seed them here too when already fetched.
      await upsertComposioConnector(ctx.connectorModel, ctx.connectorToolModel, {
        composio: {
          appSlug,
          authConfigId,
          connectedAccountId: connReq.id,
          redirectUrl: connReq.redirectUrl,
          status: 'PENDING',
        },
        identifier,
        label,
        tools,
      });

      return {
        authConfigId,
        connectedAccountId: connReq.id,
        identifier,
        redirectUrl: connReq.redirectUrl,
      };
    }),

  deleteConnection: composioProcedure
    .use(withManagedResourceGuard('composio.deleteConnection'))
    .input(
      z
        .object({
          // Legacy clients may still send the remote id. It is never trusted or
          // used; the server resolves the binding from the owned local row.
          connectedAccountId: z.string().optional(),
          connectorId: z.string().uuid().optional(),
          identifier: z.string().min(1).optional(),
        })
        .refine((input) => input.connectorId !== undefined || input.identifier !== undefined, {
          message: 'connectorId or identifier is required',
        }),
    )
    .mutation(async ({ input, ctx }) => {
      const { binding, connector } = await resolveOwnedComposioConnector(ctx.connectorModel, input);
      const app = getComposioAppByIdentifier(connector.identifier);
      if (!app || binding.appSlug.toLowerCase() !== app.appSlug.toLowerCase()) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Composio binding toolkit mismatch' });
      }
      await resolveRemoteOwnedComposioAccount(ctx, binding);

      try {
        await (ctx.composioClient.connectedAccounts as any).delete(binding.connectedAccountId);
      } catch (error) {
        console.warn('[Composio] Failed to delete remote connection:', error);
      }

      await ctx.pluginModel.delete(connector.identifier);
      await ctx.connectorModel.delete(connector.id);

      return { success: true };
    }),

  getComposioPlugins: composioProcedure.query(async ({ ctx }) => {
    const allPlugins = await ctx.pluginModel.query();
    return allPlugins.filter((plugin) => plugin.customParams?.composio);
  }),

  getConnection: composioProcedure
    .input(composioGetConnectionInputSchema)
    .query(async ({ input, ctx }) => {
      const { app, binding } = await resolveOwnedCatalogBinding(ctx, input.identifier);
      try {
        const account = await resolveRemoteOwnedComposioAccount(ctx, binding);
        return {
          appSlug: app.appSlug,
          connectedAccountId: binding.connectedAccountId,
          error: undefined as 'AUTH_ERROR' | undefined,
          status: account.status,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isAuthError = errorMessage.includes('401') || errorMessage.includes('Unauthorized');

        if (isAuthError) {
          return {
            appSlug: app.appSlug,
            connectedAccountId: binding.connectedAccountId,
            error: 'AUTH_ERROR' as const,
            status: 'FAILED',
          };
        }
        throw error;
      }
    }),

  removeComposioPlugin: composioProcedure
    .use(withManagedResourceGuard('composio.removeComposioPlugin'))
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.pluginModel.delete(input.identifier);
      await deleteComposioConnector(ctx.connectorModel, input.identifier);
      return { success: true };
    }),

  updateComposioPlugin: composioProcedure
    .use(
      withManagedResourceGuard('composio.updateComposioPlugin', {
        isExemptInput: isManagedComposioUpdateBindingInput,
      }),
    )
    .input(composioUpdatePluginInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { app, binding, state } = await assertUpdateBindingLifecycle(input, ctx);
      const remoteAccount = await resolveRemoteOwnedComposioAccount(ctx, binding);
      if (remoteAccount.status !== 'ACTIVE') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Composio did not confirm the owned binding as ACTIVE',
        });
      }

      const tools = mapTrustedComposioTools(
        await (ctx.composioClient.tools as any).getRawComposioTools({
          toolkits: [app.appSlug],
        }),
      );

      const manifest: ToolManifest = {
        api: tools.map((tool) => ({
          description: tool.description || '',
          name: tool.name,
          parameters: tool.inputSchema || { properties: {}, type: 'object' },
        })),
        identifier: app.identifier,
        meta: {
          avatar: '🔌',
          description: `Composio: ${app.label}`,
          title: app.label,
        },
        type: 'default',
      };

      const customParams = {
        composio: {
          appSlug: app.appSlug,
          authConfigId: binding.authConfigId,
          connectedAccountId: binding.connectedAccountId,
          status: 'ACTIVE',
        },
      };

      if (state.plugin) {
        await ctx.pluginModel.update(app.identifier, { customParams, manifest });
      } else {
        await ctx.pluginModel.create({
          customParams,
          identifier: app.identifier,
          manifest,
          source: 'composio',
          type: 'plugin',
        });
      }

      // Materialize only server-confirmed binding state and Composio's trusted
      // tool response; the client contract carries no tool definitions.
      await upsertComposioConnector(ctx.connectorModel, ctx.connectorToolModel, {
        composio: customParams.composio,
        identifier: app.identifier,
        label: app.label,
        replaceTools: true,
        tools,
      });

      return { savedCount: tools.length };
    }),
});

export type ComposioRouter = typeof composioRouter;
