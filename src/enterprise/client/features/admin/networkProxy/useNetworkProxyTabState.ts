'use client';

import { useCallback, useMemo } from 'react';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';

import { deriveGeodataState } from './geodataState';
import {
  useNetworkProxyArtifacts,
  useNetworkProxyNodes,
  useNetworkProxyProviderCatalog,
  useNetworkProxySettings,
  useNetworkProxyStatus,
  useNetworkProxySubscriptions,
} from './hooks';
import { useNetworkProxyActions } from './useNetworkProxyActions';

/**
 * Every query the 网络代理 tab reads, plus the state derived from them. Kept out of the tab so the
 * page component stays a composition of blocks rather than a data layer with JSX at the bottom.
 */
export const useNetworkProxyTabState = (enabled: boolean, service: AdminNetworkProxyService) => {
  const { authMethod } = useAdminAccess();

  const settingsQuery = useNetworkProxySettings(enabled, service);
  const statusQuery = useNetworkProxyStatus(enabled, service);
  const subscriptionsQuery = useNetworkProxySubscriptions(enabled, service);
  const artifactsQuery = useNetworkProxyArtifacts(enabled, service);
  const providersQuery = useNetworkProxyProviderCatalog(enabled);
  const settings = settingsQuery.data;
  const engineOutlet = settings?.config.outlet.kind === 'engine';
  const nodesQuery = useNetworkProxyNodes(enabled && Boolean(engineOutlet), service);

  const settingsStore = useMemo(
    () => ({
      apply: (next: typeof settings) => {
        if (next) void settingsQuery.mutate(next, { revalidate: false });
      },
      data: settings,
      reload: async () => settingsQuery.mutate(),
    }),
    [settings, settingsQuery],
  );

  const actions = useNetworkProxyActions({ authMethod, service, settings: settingsStore });

  const installGeodata = useCallback(() => void actions.installGeodata(), [actions]);
  const reloadArtifacts = useCallback(() => void artifactsQuery.mutate(), [artifactsQuery]);
  const reloadNodes = useCallback(() => void nodesQuery.mutate(), [nodesQuery]);
  const reloadProviders = useCallback(() => void providersQuery.mutate(), [providersQuery]);
  const reloadSettings = useCallback(() => void settingsQuery.mutate(), [settingsQuery]);
  const reloadStatus = useCallback(() => void statusQuery.mutate(), [statusQuery]);
  const reloadSubscriptions = useCallback(
    () => void subscriptionsQuery.mutate(),
    [subscriptionsQuery],
  );

  // A failed status query means "unknown", never "nothing is installed and nothing is up".
  const statusUnknown = Boolean(statusQuery.error) && !statusQuery.data;
  const artifactsUnknown = Boolean(artifactsQuery.error) && !artifactsQuery.data;
  // A failed *revalidation* is different again: what is on screen is real but old, and the
  // 15 s poll can keep failing silently. Say so rather than let stale badges look live.
  const statusStale = Boolean(statusQuery.error) && Boolean(statusQuery.data);
  const artifactsStale = Boolean(artifactsQuery.error) && Boolean(artifactsQuery.data);
  const instances = statusQuery.data?.instances ?? [];
  const current = instances.find((instance) => instance.isCurrent) ?? instances[0];
  const appliedCount = instances.filter(
    (instance) => instance.appliedRevision === settings?.revision,
  ).length;
  // Tri-state on purpose: with no instance reporting we know nothing, and "unknown" must not
  // be rendered as "not installed" (which would offer an install for a state we cannot read).
  const geodataState = useMemo(() => deriveGeodataState(current), [current]);

  // Bulk scope writes must cover every provider that HAS a scope, not only the ones the
  // catalog currently lists — otherwise "route none" silently leaves a delisted provider on.
  // ANY catalog error means the set may be incomplete, including a failed revalidation on top
  // of a cached list: a provider added since that cache would be missed by "route all".
  const providerCatalogFailed = Boolean(providersQuery.error);
  const providerIds = useMemo(() => {
    const ids = new Set((providersQuery.data ?? []).map((provider) => provider.id));
    for (const id of Object.keys(settings?.config.scopes.providers ?? {})) ids.add(id);
    return [...ids];
  }, [providersQuery.data, settings?.config.scopes.providers]);

  return {
    actions,
    appliedCount,
    artifactsQuery,
    artifactsStale,
    artifactsUnknown,
    current,
    engineOutlet,
    geodataState,
    installGeodata,
    instances,
    nodesQuery,
    providerCatalogFailed,
    providerIds,
    providersQuery,
    reloadArtifacts,
    reloadNodes,
    reloadProviders,
    reloadSettings,
    reloadStatus,
    reloadSubscriptions,
    settings,
    settingsQuery,
    statusQuery,
    statusStale,
    statusUnknown,
    subscriptionsQuery,
  };
};
