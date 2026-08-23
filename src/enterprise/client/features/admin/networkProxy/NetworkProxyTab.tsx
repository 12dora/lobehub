'use client';

import { Alert, Skeleton } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import { adminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';

import NetworkProxyBanners from './NetworkProxyBanners';
import NetworkProxyHeader from './NetworkProxyHeader';
import EngineSection from './sections/EngineSection';
import OutletSection from './sections/OutletSection';
import ScopesSection from './sections/ScopesSection';
import SubscriptionsSection from './sections/SubscriptionsSection';
import { networkProxyStyles as styles } from './styles';
import { useNetworkProxyTabState } from './useNetworkProxyTabState';

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
    const state = useNetworkProxyTabState(enabled, service);
    const {
      actions,
      artifactsQuery,
      geodataState,
      installGeodata,
      nodesQuery,
      providersQuery,
      reloadArtifacts,
      reloadStatus,
      settings,
      settingsQuery,
      statusQuery,
      subscriptionsQuery,
    } = state;

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
            <Button size="small" type="primary" onClick={state.reloadSettings}>
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
          artifactsStale={state.artifactsStale}
          canManage={canManage}
          config={config}
          geodataState={geodataState}
          globalProxyActive={globalProxyActive}
          status={statusQuery.data}
          statusError={statusQuery.error}
          statusStale={state.statusStale}
          onInstallGeodata={installGeodata}
          onReloadArtifacts={reloadArtifacts}
          onReloadStatus={reloadStatus}
        />

        {!canManage ? <Alert showIcon message={t('networkProxy.readOnly')} type="info" /> : null}

        <NetworkProxyHeader
          actions={actions}
          appliedCount={state.appliedCount}
          canManage={canManage}
          current={state.current}
          engineOutlet={state.engineOutlet}
          globalProxyActive={globalProxyActive}
          instances={state.instances}
          masterEnabled={config.masterEnabled}
          outlet={statusQuery.data?.outlet}
          providerCatalogFailed={state.providerCatalogFailed}
          providerIds={state.providerIds}
          statusStale={state.statusStale}
          statusUnknown={state.statusUnknown}
        />

        <EngineSection
          actions={actions}
          artifacts={artifactsQuery.data}
          artifactsUnknown={state.artifactsUnknown}
          canManage={canManage}
          instances={state.instances}
          revision={settings.revision}
          service={service}
          statusUnknown={state.statusUnknown}
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
          onReloadNodes={state.reloadNodes}
        />

        <SubscriptionsSection
          actions={actions}
          canManage={canManage}
          error={subscriptionsQuery.error}
          items={subscriptionsQuery.data?.items ?? []}
          loading={subscriptionsQuery.isLoading}
          subscriptionActions={actions.subscriptions}
          onRetry={state.reloadSubscriptions}
        />

        <ScopesSection
          actions={actions}
          canManage={canManage}
          config={config}
          providerCatalogFailed={state.providerCatalogFailed}
          providerIds={state.providerIds}
          providers={providersQuery.data ?? []}
          providersError={providersQuery.error}
          providersLoading={providersQuery.isLoading}
          onReloadProviders={state.reloadProviders}
        />
      </div>
    );
  },
);

NetworkProxyTab.displayName = 'NetworkProxyTab';

export default NetworkProxyTab;
