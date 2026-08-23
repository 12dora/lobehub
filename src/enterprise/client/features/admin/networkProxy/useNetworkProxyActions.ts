'use client';

import { useCallback, useMemo, useState } from 'react';

import type {
  AdminNetworkProxyConnectivity,
  AdminNetworkProxyNodeList,
  AdminNetworkProxySettings,
  AdminNetworkProxySettingsMutation,
} from '@/enterprise/client/services/adminNetworkProxy';
import { adminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  EgressScopeOp,
  NetworkProxyArtifactKind,
  NetworkProxyConfigUpdate,
} from '@/types/platform/networkProxy';

import { NetworkProxyLocalError } from './errors';
import {
  invalidateNetworkProxyEngine,
  invalidateNetworkProxyNodes,
  invalidateNetworkProxyStatus,
  invalidateNetworkProxySubscriptions,
} from './hooks';
import {
  NETWORK_PROXY_FIELDS,
  type NetworkProxyActions,
  type NetworkProxySettingsWrite,
  type NetworkProxySubscriptionActions,
  type UseNetworkProxyActionsOptions,
} from './networkProxyActionTypes';
import { useNetworkProxyEntries } from './useNetworkProxyEntries';

// The field ids, the entry shape and the action surface live next door; this module stays the one
// import path every control on the tab already uses.
export type {
  NetworkProxyActions,
  NetworkProxyEntry,
  NetworkProxyEntryStatus,
  NetworkProxyFieldId,
  NetworkProxySettingsStore,
  NetworkProxySettingsWrite,
  NetworkProxySubscriptionActions,
  UseNetworkProxyActionsOptions,
} from './networkProxyActionTypes';
export { NETWORK_PROXY_FIELDS } from './networkProxyActionTypes';

/**
 * Every write on the 网络代理 tab (design §6): instant save, no drafts to publish.
 *
 * Four rules the whole tab depends on:
 * 1. A write is a function of the freshest server bundle, never of a local draft — so a
 *    revision conflict can be retried with the winning revision without losing the admin's edit.
 * 2. The admin's chosen value stays on screen until the write commits or they dismiss it. A
 *    conflict or a 500 never snaps a switch back to the old value behind their back.
 * 3. Failure state lives per field. A successful write to one control can never clear, hide or
 *    disarm another control's pending conflict.
 * 4. Long tasks (install / restart / refresh / test) expose pending → success / error with a
 *    retry next to the control, not a toast that scrolls away.
 */
export const useNetworkProxyActions = ({
  authMethod,
  service = adminNetworkProxyService,
  settings,
}: UseNetworkProxyActionsOptions): NetworkProxyActions & {
  subscriptions: NetworkProxySubscriptionActions;
} => {
  const [latestNodes, setLatestNodes] = useState<AdminNetworkProxyNodeList | null>(null);
  const [lastConnectivity, setLastConnectivity] = useState<AdminNetworkProxyConnectivity | null>(
    null,
  );
  const {
    conflicts,
    dismiss,
    dismissAll,
    entryOf,
    isBusy,
    latestRef,
    retry,
    retryAll,
    runField,
    valueOf,
  } = useNetworkProxyEntries({ authMethod, settings });

  const runSettingsWrite = useCallback(
    async (field: string, draft: unknown, write: NetworkProxySettingsWrite): Promise<void> => {
      await runField(field, draft, async () => {
        const base = latestRef.current;
        if (!base) throw new Error('networkProxy settings not loaded');
        const next = await write(base);
        latestRef.current = next;
        settings.apply(next);
      });
    },
    [latestRef, runField, settings],
  );

  /**
   * A settings write that also kicks the answering instance. The committed revision is applied
   * either way — the desired state is stored — but `local.ok === false` puts the field in the
   * error state with the server's redacted reason and a retry, never in `success`.
   */
  const runLocalSettingsWrite = useCallback(
    async (
      field: string,
      draft: unknown,
      write: (base: AdminNetworkProxySettings) => Promise<AdminNetworkProxySettingsMutation>,
    ): Promise<void> => {
      await runField(field, draft, async () => {
        const base = latestRef.current;
        if (!base) throw new Error('networkProxy settings not loaded');
        const next = await write(base);
        latestRef.current = next;
        settings.apply(next);
        // `local.error` is an engine issue code (contract I2), not a message.
        if (!next.local.ok) throw new NetworkProxyLocalError(next.local.error);
      });
    },
    [latestRef, runField, settings],
  );

  const patchConfig = useCallback(
    (
      field: string,
      draft: unknown,
      build: (base: AdminNetworkProxySettings) => NetworkProxyConfigUpdate,
    ) =>
      runSettingsWrite(field, draft, (base) =>
        service.updateSettings({ config: build(base), expectedRevision: base.revision }),
      ),
    [runSettingsWrite, service],
  );

  const updateScopes = useCallback(
    (field: string, draft: unknown, ops: EgressScopeOp[]) =>
      runSettingsWrite(field, draft, (base) =>
        service.updateScopes({ expectedRevision: base.revision, ops }),
      ),
    [runSettingsWrite, service],
  );

  const installArtifact = useCallback(
    (kind: NetworkProxyArtifactKind) =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.install(kind), undefined, async (base) => {
        const next = await service.installArtifact({ expectedRevision: base.revision, kind });
        await Promise.all([invalidateNetworkProxyEngine(), invalidateNetworkProxyStatus()]);
        return next;
      }),
    [runLocalSettingsWrite, service],
  );

  const installGeodata = useCallback(
    () =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.installGeodata, undefined, async (base) => {
        const next = await service.installGeodata({ expectedRevision: base.revision });
        // Both the artifact catalogue and the per-instance status carry install state, and the
        // smart-routing option unlocks off the latter — refresh both, or the option stays greyed
        // out until the next 15 s poll.
        await Promise.all([invalidateNetworkProxyEngine(), invalidateNetworkProxyStatus()]);
        return next;
      }),
    [runLocalSettingsWrite, service],
  );

  const restartEngine = useCallback(
    () =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.restart, undefined, async (base) => {
        const next = await service.restartEngine({ expectedRevision: base.revision });
        await invalidateNetworkProxyEngine();
        return next;
      }),
    [runLocalSettingsWrite, service],
  );

  const selectNode = useCallback(
    (nodeName: string) =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.selectNode, nodeName, (base) =>
        service.selectNode({ expectedRevision: base.revision, nodeName }),
      ),
    [runLocalSettingsWrite, service],
  );

  const testLatency = useCallback(
    async (nodeName?: string) => {
      const field = nodeName
        ? NETWORK_PROXY_FIELDS.nodeLatency(nodeName)
        : NETWORK_PROXY_FIELDS.latency;
      await runField(field, undefined, async () => {
        const result = await service.testLatency(nodeName ? { nodeName } : {});
        setLatestNodes(result);
        await invalidateNetworkProxyNodes();
      });
    },
    [runField, service],
  );

  const testConnectivity = useCallback(async () => {
    await runField(NETWORK_PROXY_FIELDS.connectivity, undefined, async () => {
      const result = await service.testConnectivity();
      setLastConnectivity(result);
      // A reachable-but-failing outlet is not a transport error — surface it as a task failure.
      if (!result.ok) throw new Error('PLATFORM_NETWORK_PROXY_UNAVAILABLE');
    });
  }, [runField, service]);

  const runSubscription = useCallback(
    async <T>(field: string, fn: () => Promise<T>): Promise<T | null> => {
      let result: T | null = null;
      await runField(field, undefined, async () => {
        result = await fn();
        await invalidateNetworkProxySubscriptions();
      });
      return result;
    },
    [runField],
  );

  const subscriptions = useMemo<NetworkProxySubscriptionActions>(
    () => ({
      create: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscriptionCreate, () =>
          service.createSubscription(input),
        )) !== null,
      refresh: async (id) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(id), () =>
          service.refreshSubscription({ id }),
        )) !== null,
      remove: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(input.id), () =>
          service.deleteSubscription(input),
        )) !== null,
      update: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(input.id), () =>
          service.updateSubscription(input),
        )) !== null,
    }),
    [runSubscription, service],
  );

  return {
    conflicts,
    dismiss,
    dismissAll,
    entryOf,
    installArtifact,
    installGeodata,
    isBusy,
    lastConnectivity,
    latestNodes,
    patchConfig,
    restartEngine,
    retry,
    retryAll,
    selectNode,
    subscriptions,
    testConnectivity,
    testLatency,
    updateScopes,
    valueOf,
  };
};
