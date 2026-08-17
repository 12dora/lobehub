/**
 * admin.networkProxy.* — platform network-proxy settings, subscriptions, engine, outlet.
 */
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminNetworkProxyCreateSubscriptionInputSchema,
  adminNetworkProxyDeleteSubscriptionInputSchema,
  adminNetworkProxyDeleteSubscriptionOutputSchema,
  adminNetworkProxyGetArtifactStatusOutputSchema,
  adminNetworkProxyGetEngineLogsOutputSchema,
  adminNetworkProxyGetSettingsOutputSchema,
  adminNetworkProxyGetStatusOutputSchema,
  adminNetworkProxyInstallArtifactInputSchema,
  adminNetworkProxyListNodesOutputSchema,
  adminNetworkProxyListSubscriptionsOutputSchema,
  adminNetworkProxyRefreshSubscriptionInputSchema,
  adminNetworkProxyRestartEngineInputSchema,
  adminNetworkProxySelectNodeInputSchema,
  adminNetworkProxySettingsMutationOutputSchema,
  adminNetworkProxyTestConnectivityInputSchema,
  adminNetworkProxyTestConnectivityOutputSchema,
  adminNetworkProxyTestLatencyInputSchema,
  adminNetworkProxyTestLatencyOutputSchema,
  adminNetworkProxyUpdateScopesInputSchema,
  adminNetworkProxyUpdateSettingsInputSchema,
  adminNetworkProxyUpdateSubscriptionInputSchema,
  subscriptionViewSchema,
} from '../../contracts/adminNetworkProxy';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  appendInstallCompletionAudit,
  appendPostCommitAudit,
  buildArtifactStatusView,
  currentInstanceId,
  desiredArtifactsPatchFor,
  getNetworkProxyRuntime,
  hashNameForAudit,
  installAuditActionFor,
  isDangerousSettingsUpdate,
  mapNetworkProxyError,
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
  runLocalArtifactInstall,
  runLocalEngineAction,
  summarizeScopesAfterDiff,
  summarizeSettingsAfterDiff,
  summarizeSubscriptionAfterDiff,
  testOutletConnectivity,
  toSettingsMutationOutput,
  toSettingsOutput,
  withLocalInstanceStatus,
} from './networkProxySupport';

const adminBase = preAccessAuthedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const networkProxyRead = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.NETWORK_PROXY_READ),
);
const networkProxyManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE),
);

const assertNetworkProxyReauth = async (
  ctx: {
    authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
    authenticatedAt?: Date | null;
    serverDB: ConstructorParameters<typeof PlatformAuditService>[0];
    userId: string;
  },
  denied: {
    action: (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];
    reason?: string | null;
    targetId: string;
    targetType: (typeof NETWORK_PROXY_AUDIT_TARGET_TYPES)[keyof typeof NETWORK_PROXY_AUDIT_TARGET_TYPES];
  },
) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    denied: {
      action: denied.action,
      actorUserId: ctx.userId,
      reason: denied.reason,
      targetId: denied.targetId,
      targetType: denied.targetType,
    },
    serverDB: ctx.serverDB,
  });

export const adminNetworkProxyRouter = router({
  createSubscription: networkProxyManage
    .input(adminNetworkProxyCreateSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertNetworkProxyReauth(
          {
            authMethod: ctx.authMethod,
            authenticatedAt: ctx.authenticatedAt,
            serverDB: ctx.serverDB,
            userId: ctx.userId!,
          },
          {
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          },
        );

        const runtime = await getNetworkProxyRuntime();
        const created = await ctx.serverDB.transaction(async (tx) => {
          const view = await runtime.createSubscriptionRecord(tx, input, ctx.userId!);
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
            actorUserId: ctx.userId!,
            afterDiff: summarizeSubscriptionAfterDiff(view, runtime.redactSecrets),
            result: 'success',
            targetId: view.id,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          });
          return view;
        });
        const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
        await runtime.publishNetworkProxyInvalidation(settings.revision);
        return created;
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  deleteSubscription: networkProxyManage
    .input(adminNetworkProxyDeleteSubscriptionInputSchema)
    .output(adminNetworkProxyDeleteSubscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        await ctx.serverDB.transaction(async (tx) => {
          await runtime.deleteSubscriptionRecord(tx, input.id);
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_DELETE,
            actorUserId: ctx.userId!,
            afterDiff: { id: input.id },
            reason: input.reason,
            result: 'success',
            targetId: input.id,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          });
        });
        const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
        await runtime.publishNetworkProxyInvalidation(settings.revision);
        return { ok: true } as const;
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  getArtifactStatus: networkProxyRead
    .output(adminNetworkProxyGetArtifactStatusOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        return await buildArtifactStatusView(runtime, ctx.serverDB);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  getEngineLogs: networkProxyRead
    .output(adminNetworkProxyGetEngineLogsOutputSchema)
    .query(async () => {
      try {
        const runtime = await getNetworkProxyRuntime();
        return {
          instanceId: currentInstanceId(),
          lines: runtime.getEngineRuntime().getLogs(),
        };
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  getSettings: networkProxyRead
    .output(adminNetworkProxyGetSettingsOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const row = await runtime.getNetworkProxySettings(ctx.serverDB);
        return toSettingsOutput(row, runtime);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  getStatus: networkProxyRead
    .output(adminNetworkProxyGetStatusOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const instanceId = currentInstanceId();
        const [row, freshInstances] = await Promise.all([
          runtime.getNetworkProxySettings(ctx.serverDB),
          runtime.listFreshInstanceStatuses(ctx.serverDB, instanceId),
        ]);
        const instances = await withLocalInstanceStatus(runtime, freshInstances, instanceId);
        return {
          fallbackScopes: runtime.getEgressCounters().fallbackScopes,
          globalProxyActive: runtime.isLegacyGlobalProxyActive(),
          instances,
          outlet: runtime.getOutletHealth(),
          revision: row.revision,
        };
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  installArtifact: networkProxyManage
    .input(adminNetworkProxyInstallArtifactInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertNetworkProxyReauth(
          {
            authMethod: ctx.authMethod,
            authenticatedAt: ctx.authenticatedAt,
            serverDB: ctx.serverDB,
            userId: ctx.userId!,
          },
          {
            action: installAuditActionFor(input.kind),
            targetId: input.kind,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
          },
        );

        const runtime = await getNetworkProxyRuntime();
        const patch = desiredArtifactsPatchFor(input.kind, new Date().toISOString());
        const next = await ctx.serverDB.transaction(async (tx) => {
          const row = await runtime.setDesiredArtifacts(tx, patch, {
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: installAuditActionFor(input.kind),
            actorUserId: ctx.userId!,
            afterDiff: {
              kind: input.kind,
              revision: row.revision,
              source: 'download',
              ...(input.kind === 'engine'
                ? { version: patch.engine?.version }
                : { commit: patch.geoip?.commit ?? patch.geosite?.commit }),
            },
            configRevision: row.revision,
            result: 'success',
            targetId: input.kind,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
          });
          return row;
        });

        await runtime.publishNetworkProxyInvalidation(next.revision);
        const snapshot = runtime.peekNetworkProxySnapshot();
        const proxyUrl = next.config.downloadViaStaticProxy
          ? (snapshot?.staticProxyUrl ?? null)
          : null;
        const local = await runLocalArtifactInstall(runtime, input.kind, proxyUrl);
        await appendInstallCompletionAudit(
          { serverDB: ctx.serverDB, userId: ctx.userId! },
          { kind: input.kind, local, revision: next.revision },
        );
        return toSettingsMutationOutput(next, runtime, {
          error: local.error,
          ok: local.ok,
        });
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  listNodes: networkProxyRead.output(adminNetworkProxyListNodesOutputSchema).query(async () => {
    try {
      const runtime = await getNetworkProxyRuntime();
      const engine = runtime.getEngineRuntime();
      const engineState = engine.getState().state;
      // No engine process → nothing to list; that is a normal state, not an error.
      const nodes =
        engineState === 'running' || engineState === 'degraded' ? await engine.listNodes() : [];
      return {
        engineState,
        instanceId: currentInstanceId(),
        nodes,
      };
    } catch (error) {
      return mapNetworkProxyError(error);
    }
  }),

  listSubscriptions: networkProxyRead
    .output(adminNetworkProxyListSubscriptionsOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        return { items: await runtime.listSubscriptionViews(ctx.serverDB) };
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  refreshSubscription: networkProxyManage
    .input(adminNetworkProxyRefreshSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const view = await ctx.serverDB.transaction(async (tx) => {
          await runtime.requestSubscriptionRefresh(tx, input.id);
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_REFRESH,
            actorUserId: ctx.userId!,
            afterDiff: { id: input.id },
            result: 'success',
            targetId: input.id,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          });
          const items = await runtime.listSubscriptionViews(tx);
          const found = items.find((item) => item.id === input.id);
          if (!found) {
            throw new Error('PLATFORM_NOT_FOUND');
          }
          return found;
        });
        const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
        await runtime.publishNetworkProxyInvalidation(settings.revision);
        await runLocalEngineAction(
          'refreshSubscriptionNow',
          () => runtime.getEngineRuntime().refreshSubscriptionNow(input.id),
          runtime.redactSecrets,
        );
        return view;
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  restartEngine: networkProxyManage
    .input(adminNetworkProxyRestartEngineInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const next = await ctx.serverDB.transaction(async (tx) => {
          const row = await runtime.bumpEngineGeneration(tx, {
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_RESTART,
            actorUserId: ctx.userId!,
            afterDiff: { engineGeneration: row.engineGeneration, revision: row.revision },
            configRevision: row.revision,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
          });
          return row;
        });
        await runtime.publishNetworkProxyInvalidation(next.revision);
        const local = await runLocalEngineAction(
          'restartEngine',
          () => runtime.getEngineRuntime().restart(),
          runtime.redactSecrets,
        );
        await appendPostCommitAudit(
          { serverDB: ctx.serverDB, userId: ctx.userId! },
          {
            action: NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_RESTART,
            afterDiff: {
              engineGeneration: next.engineGeneration,
              localOutcome: local,
              revision: next.revision,
            },
            configRevision: next.revision,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
          },
        );
        return toSettingsMutationOutput(next, runtime, local);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  selectNode: networkProxyManage
    .input(adminNetworkProxySelectNodeInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const current = await runtime.getNetworkProxySettings(ctx.serverDB);
        const nextConfig = {
          ...current.config,
          outlet: { ...current.config.outlet, manualNodeName: input.nodeName },
        };
        const next = await ctx.serverDB.transaction(async (tx) => {
          const row = await runtime.updateNetworkProxySettings(tx, {
            config: nextConfig,
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.OUTLET_SELECT_NODE,
            actorUserId: ctx.userId!,
            afterDiff: { nodeNameHash: hashNameForAudit(input.nodeName), revision: row.revision },
            configRevision: row.revision,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
          });
          return row;
        });
        await runtime.publishNetworkProxyInvalidation(next.revision);
        const local = await runLocalEngineAction(
          'selectNode',
          () => runtime.getEngineRuntime().selectNode(input.nodeName),
          runtime.redactSecrets,
        );
        await appendPostCommitAudit(
          { serverDB: ctx.serverDB, userId: ctx.userId! },
          {
            action: NETWORK_PROXY_AUDIT_ACTIONS.OUTLET_SELECT_NODE,
            afterDiff: {
              localOutcome: local,
              nodeNameHash: hashNameForAudit(input.nodeName),
              revision: next.revision,
            },
            configRevision: next.revision,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
          },
        );
        return toSettingsMutationOutput(next, runtime, local);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  testConnectivity: networkProxyManage
    .input(adminNetworkProxyTestConnectivityInputSchema)
    .output(adminNetworkProxyTestConnectivityOutputSchema)
    .mutation(async ({ ctx }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
        return await testOutletConnectivity(runtime, settings.config.outlet.latencyTestUrl);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  testLatency: networkProxyManage
    .input(adminNetworkProxyTestLatencyInputSchema)
    .output(adminNetworkProxyTestLatencyOutputSchema)
    .mutation(async ({ input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const engine = runtime.getEngineRuntime();
        const nodes = input.nodeName
          ? await engine.testNodeDelay(input.nodeName).then(async () => engine.listNodes())
          : await engine.testGroupDelay();
        return { instanceId: currentInstanceId(), nodes };
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  updateScopes: networkProxyManage
    .input(adminNetworkProxyUpdateScopesInputSchema)
    .output(adminNetworkProxyGetSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const current = await runtime.getNetworkProxySettings(ctx.serverDB);
        const nextConfig = runtime.applyScopeOps(current.config, input.ops);
        const next = await ctx.serverDB.transaction(async (tx) => {
          const row = await runtime.updateNetworkProxySettings(tx, {
            config: nextConfig,
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SCOPES_UPDATE,
            actorUserId: ctx.userId!,
            afterDiff: summarizeScopesAfterDiff(nextConfig, input.ops.length, row.revision),
            configRevision: row.revision,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
          });
          return row;
        });
        await runtime.publishNetworkProxyInvalidation(next.revision);
        return toSettingsOutput(next, runtime);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  updateSettings: networkProxyManage
    .input(adminNetworkProxyUpdateSettingsInputSchema)
    .output(adminNetworkProxyGetSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const runtime = await getNetworkProxyRuntime();
        const current = await runtime.getNetworkProxySettings(ctx.serverDB);
        if (isDangerousSettingsUpdate(current.config, input.config)) {
          await assertNetworkProxyReauth(
            {
              authMethod: ctx.authMethod,
              authenticatedAt: ctx.authenticatedAt,
              serverDB: ctx.serverDB,
              userId: ctx.userId!,
            },
            {
              action: NETWORK_PROXY_AUDIT_ACTIONS.SETTINGS_UPDATE,
              reason: input.reason,
              targetId: NETWORK_PROXY_SETTINGS_ID,
              targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
            },
          );
        }

        const next = await ctx.serverDB.transaction(async (tx) => {
          const staticProxy = await runtime.applyStaticProxyUpdate(
            current.config.staticProxy,
            input.config.staticProxy,
          );
          const nextConfig = {
            bypassHosts: input.config.bypassHosts,
            downloadViaStaticProxy: input.config.downloadViaStaticProxy,
            engineLogLevel: input.config.engineLogLevel,
            masterEnabled: input.config.masterEnabled,
            outlet: input.config.outlet,
            ruleMode: input.config.ruleMode,
            scopes: current.config.scopes,
            staticProxy,
            subscriptionUpdateViaOutlet: input.config.subscriptionUpdateViaOutlet,
          };
          runtime.assertCanEnable(nextConfig);
          const row = await runtime.updateNetworkProxySettings(tx, {
            config: nextConfig,
            expectedRevision: input.expectedRevision,
            updatedBy: ctx.userId!,
          });
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SETTINGS_UPDATE,
            actorUserId: ctx.userId!,
            afterDiff: summarizeSettingsAfterDiff(nextConfig, row.revision),
            configRevision: row.revision,
            reason: input.reason,
            result: 'success',
            targetId: NETWORK_PROXY_SETTINGS_ID,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
          });
          return row;
        });
        await runtime.publishNetworkProxyInvalidation(next.revision);
        return toSettingsOutput(next, runtime);
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),

  updateSubscription: networkProxyManage
    .input(adminNetworkProxyUpdateSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertNetworkProxyReauth(
          {
            authMethod: ctx.authMethod,
            authenticatedAt: ctx.authenticatedAt,
            serverDB: ctx.serverDB,
            userId: ctx.userId!,
          },
          {
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_UPDATE,
            targetId: input.id,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          },
        );

        const runtime = await getNetworkProxyRuntime();
        const updated = await ctx.serverDB.transaction(async (tx) => {
          const view = await runtime.updateSubscriptionRecord(tx, input, ctx.userId!);
          await new PlatformAuditService(tx).append({
            action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_UPDATE,
            actorUserId: ctx.userId!,
            afterDiff: summarizeSubscriptionAfterDiff(view, runtime.redactSecrets),
            result: 'success',
            targetId: view.id,
            targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
          });
          return view;
        });
        const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
        await runtime.publishNetworkProxyInvalidation(settings.revision);
        return updated;
      } catch (error) {
        return mapNetworkProxyError(error);
      }
    }),
});
