'use client';

import { Alert, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button, type DropdownItem, DropdownMenu, Switch } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import { adminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type { EgressScopeOp } from '@/types/platform/networkProxy';

import { applyConfigPatch } from './configUpdate';
import FieldStatus from './FieldStatus';
import { formatDelay } from './format';
import {
  useNetworkProxyArtifacts,
  useNetworkProxyNodes,
  useNetworkProxyProviderCatalog,
  useNetworkProxySettings,
  useNetworkProxyStatus,
  useNetworkProxySubscriptions,
} from './hooks';
import NetworkProxyBanners from './NetworkProxyBanners';
import EngineSection from './sections/EngineSection';
import OutletSection from './sections/OutletSection';
import ScopesSection from './sections/ScopesSection';
import SubscriptionsSection from './sections/SubscriptionsSection';
import { networkProxyStyles as styles } from './styles';
import { NETWORK_PROXY_FIELDS, useNetworkProxyActions } from './useNetworkProxyActions';

export interface NetworkProxyTabProps {
  canManage: boolean;
  /** Fire the queries only when the admin may read the domain. */
  enabled: boolean;
  service?: AdminNetworkProxyService;
}

const ENGINE_TAG_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  degraded: 'warning',
  error: 'error',
  installing: 'warning',
  not_installed: 'default',
  running: 'success',
  starting: 'warning',
  stopped: 'default',
  unsupported: 'error',
};

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
    const geodataReady = useMemo(
      () =>
        (['geoip', 'geosite'] as const).every((kind) =>
          Boolean(current?.artifacts.find((item) => item.kind === kind)?.installed),
        ),
      [current?.artifacts],
    );

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

    const moreActions = useMemo<DropdownItem[]>(() => {
      const scopeOps = (field: string, ops: EgressScopeOp[]) => () =>
        void actions.updateScopes(field, undefined, ops);
      // Without the catalog we cannot know the full provider set, so a bulk write would burn a
      // revision while leaving unknown providers untouched.
      const bulkDisabled = !canManage || providerCatalogFailed;
      const bulkLabel = (label: string) =>
        providerCatalogFailed ? t('networkProxy.scopes.bulkUnavailableLabel', { label }) : label;
      return [
        {
          disabled: bulkDisabled,
          key: 'providers-on',
          label: bulkLabel(t('networkProxy.more.providersOn')),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { enabled: true, providerIds, target: 'all_providers' },
          ]),
        },
        {
          disabled: bulkDisabled,
          key: 'providers-off',
          label: bulkLabel(t('networkProxy.more.providersOff')),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { enabled: false, providerIds, target: 'all_providers' },
          ]),
        },
        {
          disabled: !canManage,
          key: 'features-on',
          label: t('networkProxy.more.featuresOn'),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { enabled: true, target: 'all_features' },
          ]),
        },
        {
          disabled: !canManage,
          key: 'features-off',
          label: t('networkProxy.more.featuresOff'),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { enabled: false, target: 'all_features' },
          ]),
        },
        { key: 'divider-1', type: 'divider' },
        {
          disabled: bulkDisabled,
          key: 'fallback-direct',
          label: bulkLabel(t('networkProxy.more.fallbackDirect')),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { onUnavailable: 'direct', providerIds, target: 'all_providers' },
            { onUnavailable: 'direct', target: 'all_features' },
          ]),
        },
        {
          disabled: bulkDisabled,
          key: 'fallback-fail',
          label: bulkLabel(t('networkProxy.more.fallbackFail')),
          onClick: scopeOps(NETWORK_PROXY_FIELDS.scopesBulk, [
            { onUnavailable: 'fail', providerIds, target: 'all_providers' },
            { onUnavailable: 'fail', target: 'all_features' },
          ]),
        },
        { key: 'divider-2', type: 'divider' },
        {
          disabled: !canManage || !engineOutlet,
          key: 'group-latency',
          label: t('networkProxy.more.groupLatency'),
          onClick: () => void actions.testLatency(),
        },
        {
          disabled: !canManage,
          key: 'restart-engine',
          label: t('networkProxy.more.restartEngine'),
          onClick: () => void actions.restartEngine(),
        },
      ];
    }, [actions, canManage, engineOutlet, providerCatalogFailed, providerIds, t]);

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
    const outlet = statusQuery.data?.outlet;
    const masterLocked = globalProxyActive || !canManage;
    const masterChecked = actions.valueOf(NETWORK_PROXY_FIELDS.master, config.masterEnabled);

    return (
      <div className={styles.stack}>
        <NetworkProxyBanners
          actions={actions}
          artifacts={artifactsQuery.data}
          artifactsError={artifactsQuery.error}
          artifactsStale={artifactsStale}
          canManage={canManage}
          config={config}
          geodataReady={geodataReady}
          globalProxyActive={globalProxyActive}
          status={statusQuery.data}
          statusError={statusQuery.error}
          statusStale={statusStale}
          onInstallGeodata={installGeodata}
          onReloadArtifacts={reloadArtifacts}
          onReloadStatus={reloadStatus}
        />

        {!canManage ? <Alert showIcon message={t('networkProxy.readOnly')} type="info" /> : null}

        <div className={styles.headerBar}>
          <div className={styles.headerPrimary}>
            <Switch
              aria-label={t('networkProxy.master')}
              checked={masterChecked}
              disabled={masterLocked || actions.isBusy(NETWORK_PROXY_FIELDS.master)}
              onChange={(checked) =>
                void actions.patchConfig(NETWORK_PROXY_FIELDS.master, Boolean(checked), (base) =>
                  applyConfigPatch(base.config, { masterEnabled: Boolean(checked) }),
                )
              }
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <Text strong>{t('networkProxy.master')}</Text>
              <span className={styles.hintText}>
                {globalProxyActive
                  ? t('networkProxy.masterLockedByEnv')
                  : masterChecked
                    ? t('networkProxy.masterOnHint')
                    : t('networkProxy.masterOffHint')}
              </span>
              <FieldStatus actions={actions} field={NETWORK_PROXY_FIELDS.master} />
            </div>
          </div>

          <div className={styles.badgeRow}>
            {statusUnknown ? (
              <Tag color="default">{t('networkProxy.badges.unknown')}</Tag>
            ) : (
              <>
                {statusStale ? <Tag color="warning">{t('networkProxy.badges.stale')}</Tag> : null}
                <Tag color={ENGINE_TAG_COLOR[current?.engineState ?? 'not_installed'] ?? 'default'}>
                  {t('networkProxy.badges.engine', {
                    state: t(
                      `networkProxy.engineState.${current?.engineState ?? 'not_installed'}` as never,
                    ),
                  })}
                </Tag>
                <Tag color={outlet?.available ? 'success' : 'error'}>
                  {t(
                    outlet?.available
                      ? 'networkProxy.badges.outletUp'
                      : 'networkProxy.badges.outletDown',
                  )}
                </Tag>
                <Tag>
                  {t('networkProxy.badges.node', {
                    delay: formatDelay(outlet?.activeNodeDelayMs),
                    node: outlet?.activeNode ?? t('networkProxy.badges.noNode'),
                  })}
                </Tag>
                {/* One node is either on the current configuration or it is not — the ratio only
                    means something once there is a fleet to be out of step with. */}
                {instances.length > 1 ? (
                  <Tag color={appliedCount === instances.length ? 'default' : 'warning'}>
                    {t('networkProxy.badges.applied', {
                      applied: appliedCount,
                      total: instances.length,
                    })}
                  </Tag>
                ) : null}
              </>
            )}
            <DropdownMenu items={moreActions} placement="bottomRight">
              <Button size="small">{t('networkProxy.more.title')}</Button>
            </DropdownMenu>
          </div>
        </div>

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
          geodataReady={geodataReady}
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
