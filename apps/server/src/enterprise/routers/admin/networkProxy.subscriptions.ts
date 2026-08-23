import type { z } from 'zod';

import type {
  adminNetworkProxyCreateSubscriptionInputSchema,
  adminNetworkProxyDeleteSubscriptionInputSchema,
  adminNetworkProxyRefreshSubscriptionInputSchema,
  adminNetworkProxyUpdateSubscriptionInputSchema,
} from '../../contracts/adminNetworkProxy';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertNetworkProxyReauth, type NetworkProxyCtx } from './networkProxy.context';
import {
  getNetworkProxyRuntime,
  mapNetworkProxyError,
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
  runLocalEngineAction,
  summarizeSubscriptionAfterDiff,
} from './networkProxySupport';

export const createSubscription = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyCreateSubscriptionInputSchema>;
}) => {
  try {
    await assertNetworkProxyReauth(ctx, {
      action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
      targetId: NETWORK_PROXY_SETTINGS_ID,
      targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
    });

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
};

export const deleteSubscription = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyDeleteSubscriptionInputSchema>;
}) => {
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
};

export const listSubscriptions = async ({ ctx }: { ctx: NetworkProxyCtx }) => {
  try {
    const runtime = await getNetworkProxyRuntime();
    return { items: await runtime.listSubscriptionViews(ctx.serverDB) };
  } catch (error) {
    return mapNetworkProxyError(error);
  }
};

export const refreshSubscription = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyRefreshSubscriptionInputSchema>;
}) => {
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
};

export const updateSubscription = async ({
  ctx,
  input,
}: {
  ctx: NetworkProxyCtx;
  input: z.infer<typeof adminNetworkProxyUpdateSubscriptionInputSchema>;
}) => {
  try {
    await assertNetworkProxyReauth(ctx, {
      action: NETWORK_PROXY_AUDIT_ACTIONS.SUBSCRIPTION_UPDATE,
      targetId: input.id,
      targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.SUBSCRIPTION,
    });

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
};
