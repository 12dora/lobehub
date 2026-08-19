'use client';

import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import { adminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';

import { deriveGeodataState } from './geodataState';
import {
  useNetworkProxyArtifacts,
  useNetworkProxyNodes,
  useNetworkProxyProviderCatalog,
  useNetworkProxySettings,
  useNetworkProxyStatus,
  useNetworkProxySubscriptions,
} from './hooks';
import NetworkProxyBanners from './NetworkProxyBanners';
import NetworkProxyHeader from './NetworkProxyHeader';
import EngineSection from './sections/EngineSection';
import OutletSection from './sections/OutletSection';
import ScopesSection from './sections/ScopesSection';
import SubscriptionsSection from './sections/SubscriptionsSection';
import { networkProxyStyles as styles } from './styles';
import { useNetworkProxyActions } from './useNetworkProxyActions';

export interface NetworkProxyTabProps {
  canManage: boolean;
  /** Fire the queries only when the admin may read the domain. */
  enabled: boolean;
  service?: AdminNetworkProxyService;
}

/**
 * 系统 → 通用设置 → 网络代理 (design §6).
 *
 * One primary control — the master switch — then status, then four blocks: engine, outlet &
 * nodes, subscriptions, scopes. Everything saves immediately; the only thing that can be "in
 * progress" is a long task, and those report pending → success / failure in place.
 */
const NetworkProxyTab = memo<NetworkProxyTabProps>(
  ({ canManage, enabled, service = adminNetworkProxyService }) => {
    const { t } = useTranslation('admin');
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
    const reloadStatus = useCallback(() => void statusQuery.mutate(), [statusQuery]);

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

    if (settingsQuery.isLoading && !settings) {
      return <Skeleton.Block height={360} width="100%" />;
    }

    if (settingsQuery.error && !settings) {
      return (
        <Alert
          showIcon
          description={t('networkProxy.loadFailedDesc')}
          message={t('networkProxy.loadFailed')}
          type="error"
          action={
            <Button size="small" type="primary" onClick={() => void settingsQuery.mutate()}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      );
    }

    if (!settings) return null;

    const { config, globalProxyActive } = settings;

    return (
      <div className={styles.stack}>
        <NetworkProxyBanners
          actions={actions}
          artifacts={artifactsQuery.data}
          artifactsError={artifactsQuery.error}
          artifactsStale={artifactsStale}
          canManage={canManage}
          config={config}
          geodataState={geodataState}
          globalProxyActive={globalProxyActive}
          status={statusQuery.data}
          statusError={statusQuery.error}
          statusStale={statusStale}
          onInstallGeodata={installGeodata}
          onReloadArtifacts={reloadArtifacts}
          onReloadStatus={reloadStatus}
        />

        {!canManage ? <Alert showIcon message={t('networkProxy.readOnly')} type="info" /> : null}

        <NetworkProxyHeader
          actions={actions}
          appliedCount={appliedCount}
          canManage={canManage}
          current={current}
          engineOutlet={engineOutlet}
          globalProxyActive={globalProxyActive}
          instances={instances}
          masterEnabled={config.masterEnabled}
          outlet={statusQuery.data?.outlet}
          providerCatalogFailed={providerCatalogFailed}
          providerIds={providerIds}
          statusStale={statusStale}
          statusUnknown={statusUnknown}
        />

        <EngineSection
          actions={actions}
          artifacts={artifactsQuery.data}
          artifactsUnknown={artifactsUnknown}
          canManage={canManage}
          instances={instances}
          revision={settings.revision}
          service={service}
          statusUnknown={statusUnknown}
          onReloadArtifacts={reloadArtifacts}
          onReloadStatus={reloadStatus}
        />

        <OutletSection
          actions={actions}
          canManage={canManage}
          config={config}
          geodataState={geodataState}
          nodes={nodesQuery.data}
          nodesError={nodesQuery.error}
          nodesLoading={nodesQuery.isLoading}
          subscriptions={subscriptionsQuery.data?.items ?? []}
          onInstallGeodata={installGeodata}
          onReloadNodes={reloadNodes}
        />

        <SubscriptionsSection
          actions={actions}
          canManage={canManage}
          error={subscriptionsQuery.error}
          items={subscriptionsQuery.data?.items ?? []}
          loading={subscriptionsQuery.isLoading}
          subscriptionActions={actions.subscriptions}
          onRetry={() => void subscriptionsQuery.mutate()}
        />

        <ScopesSection
          actions={actions}
          canManage={canManage}
          config={config}
          providerCatalogFailed={providerCatalogFailed}
          providerIds={providerIds}
          providers={providersQuery.data ?? []}
          providersError={providersQuery.error}
          providersLoading={providersQuery.isLoading}
          onReloadProviders={reloadProviders}
        />
      </div>
    );
  },
);

NetworkProxyTab.displayName = 'NetworkProxyTab';

export default NetworkProxyTab;
