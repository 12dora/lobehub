import type { z } from 'zod';

import type {
  adminNetworkProxyInstallArtifactInputSchema,
  adminNetworkProxyInstallGeodataInputSchema,
  adminNetworkProxyRestartEngineInputSchema,
  adminNetworkProxySelectNodeInputSchema,
  adminNetworkProxyTestLatencyInputSchema,
} from '../../contracts/adminNetworkProxy';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertNetworkProxyReauth, type NetworkProxyCtx } from './networkProxy.context';
import {
  geodataInstallAfterDiff,
  mergeDesiredGeodataPatch,
  runLocalGeodataInstalls,
} from './networkProxyGeodata';
import {
  appendInstallCompletionAudit,
  appendPostCommitAudit,
  currentInstanceId,
  desiredArtifactsPatchFor,
  getNetworkProxyRuntime,
  hashNameForAudit,
  installAuditActionFor,
  mapNetworkProxyError,
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
  runLocalArtifactInstall,
  runLocalEngineAction,
  toSettingsMutationOutput,
} from './networkProxySupport';

export const getEngineLogs = async () => {
  try {
    const runtime = await getNetworkProxyRuntime();
    return {
      instanceId: currentInstanceId(),
      lines: runtime.getEngineRuntime().getLogs(),
    };
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const installArtifact = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyInstallArtifactInputSchema>;
}) => {
  try {
    await assertNetworkProxyReauth(ctx, {
      action: installAuditActionFor(input.kind),
      targetId: input.kind,
      targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
    });

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
    const proxyUrl = next.config.downloadViaStaticProxy ? (snapshot?.staticProxyUrl ?? null) : null;
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
};

export const installGeodata = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyInstallGeodataInputSchema>;
}) => {
  try {
    await assertNetworkProxyReauth(ctx, {
      action: NETWORK_PROXY_AUDIT_ACTIONS.GEODATA_INSTALL,
      targetId: 'geodata',
      targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
    });

    const runtime = await getNetworkProxyRuntime();
    const patch = mergeDesiredGeodataPatch(new Date().toISOString());
    const next = await ctx.serverDB.transaction(async (tx) => {
      const row = await runtime.setDesiredArtifacts(tx, patch, {
        expectedRevision: input.expectedRevision,
        updatedBy: ctx.userId!,
      });
      await new PlatformAuditService(tx).append({
        action: NETWORK_PROXY_AUDIT_ACTIONS.GEODATA_INSTALL,
        actorUserId: ctx.userId!,
        afterDiff: geodataInstallAfterDiff(row.revision),
        configRevision: row.revision,
        result: 'success',
        targetId: 'geodata',
        targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
      });
      return row;
    });

    await runtime.publishNetworkProxyInvalidation(next.revision);
    const snapshot = runtime.peekNetworkProxySnapshot();
    const proxyUrl = next.config.downloadViaStaticProxy ? (snapshot?.staticProxyUrl ?? null) : null;
    const { local, results } = await runLocalGeodataInstalls(runtime, {
      proxyUrl,
      revision: next.revision,
      serverDB: ctx.serverDB,
      userId: ctx.userId!,
    });
    return { ...toSettingsMutationOutput(next, runtime, local), results };
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const listNodes = async () => {
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
};

export const restartEngine = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyRestartEngineInputSchema>;
}) => {
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
};

export const selectNode = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxySelectNodeInputSchema>;
}) => {
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
};

export const testLatency = async ({
  input,
}: {
  input: z.infer<typeof adminNetworkProxyTestLatencyInputSchema>;
}) => {
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
};
