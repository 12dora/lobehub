import type { z } from 'zod';

import type {
  adminNetworkProxyUpdateScopesInputSchema,
  adminNetworkProxyUpdateSettingsInputSchema,
} from '../../contracts/adminNetworkProxy';
import { assertSmartModeGeodata } from '../../services/networkProxy/settingsService';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertNetworkProxyReauth, type NetworkProxyCtx } from './networkProxy.context';
import {
  buildArtifactStatusView,
  currentInstanceId,
  getNetworkProxyRuntime,
  isDangerousSettingsUpdate,
  mapNetworkProxyError,
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
  summarizeScopesAfterDiff,
  summarizeSettingsAfterDiff,
  testOutletConnectivity,
  toSettingsOutput,
  withLocalInstanceStatus,
} from './networkProxySupport';

export const getArtifactStatus = async ({ ctx }: { ctx: NetworkProxyCtx }) => {
  try {
    const runtime = await getNetworkProxyRuntime();
    return await buildArtifactStatusView(runtime, ctx.serverDB);
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const getSettings = async ({ ctx }: { ctx: NetworkProxyCtx }) => {
  try {
    const runtime = await getNetworkProxyRuntime();
    const row = await runtime.getNetworkProxySettings(ctx.serverDB);
    return toSettingsOutput(row, runtime);
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const getStatus = async ({ ctx }: { ctx: NetworkProxyCtx }) => {
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
};

export const testConnectivity = async ({ ctx }: { ctx: NetworkProxyCtx }) => {
  try {
    const runtime = await getNetworkProxyRuntime();
    const settings = await runtime.getNetworkProxySettings(ctx.serverDB);
    return await testOutletConnectivity(runtime, settings.config.outlet.latencyTestUrl);
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const updateScopes = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyUpdateScopesInputSchema>;
}) => {
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
};

export const updateSettings = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyUpdateSettingsInputSchema>;
}) => {
  try {
    const runtime = await getNetworkProxyRuntime();
    const current = await runtime.getNetworkProxySettings(ctx.serverDB);
    if (isDangerousSettingsUpdate(current.config, input.config)) {
      await assertNetworkProxyReauth(ctx, {
        action: NETWORK_PROXY_AUDIT_ACTIONS.SETTINGS_UPDATE,
        reason: input.reason,
        targetId: NETWORK_PROXY_SETTINGS_ID,
        targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SETTINGS,
      });
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
      assertSmartModeGeodata(nextConfig, current.desiredArtifacts, {
        currentRuleMode: current.config.ruleMode,
        ruleModeTouched: true,
      });
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
};
