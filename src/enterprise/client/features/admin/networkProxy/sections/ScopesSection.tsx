'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_FEATURE_KEYS } from '@/const/platform/networkProxy';
import type { EgressScopeOp, NetworkProxyConfigView } from '@/types/platform/networkProxy';

import { firstColumnFilterValue } from '../../primitives/columnFilters';
import DataTable from '../../primitives/DataTable';
import FieldStatus from '../FieldStatus';
import type { NetworkProxyProviderOption } from '../hooks';
import { Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import { useFeatureScopeColumns, useProviderScopeColumns } from './scopeColumns';
import {
  buildProviderScopeRows,
  type FeatureScopeRow,
  OFF_SCOPE,
  type ProviderFilters,
  type ProviderScopeRow,
} from './scopeRows';

export interface ScopesSectionProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  config: NetworkProxyConfigView;
  onReloadProviders: () => void;
  /** The catalog query failed with nothing cached — the provider set is incomplete. */
  providerCatalogFailed: boolean;
  /** Union of catalog ids and already-scoped ids — what a bulk write must cover. */
  providerIds: string[];
  providers: NetworkProxyProviderOption[];
  providersError?: unknown;
  providersLoading?: boolean;
}

/**
 * 作用域 (design §6.4). Two tables — AI 服务商 and 网站功能 — with the same two controls:
 * does this traffic go through the outlet, and what happens when the outlet is down.
 *
 * Every change saves immediately; there is no draft to forget to publish. A failed or
 * conflicting save keeps the switch where the admin put it and offers a retry next to it,
 * rather than snapping back.
 */
const ScopesSection = memo<ScopesSectionProps>(
  ({
    actions,
    canManage,
    config,
    onReloadProviders,
    providerCatalogFailed,
    providerIds,
    providers,
    providersError,
    providersLoading,
  }) => {
    const { t } = useTranslation('admin');
    const [filters, setFilters] = useState<ProviderFilters>({});
    const bulkBusy = actions.isBusy(NETWORK_PROXY_FIELDS.scopesBulk);
    const disabled = !canManage || bulkBusy;
    // Without the full catalog a bulk write would burn a revision while leaving providers we
    // cannot see untouched — which reads as "route none" having silently failed.
    const bulkDisabled = disabled || providerCatalogFailed;

    const providerRows = useMemo<ProviderScopeRow[]>(
      () => buildProviderScopeRows(providers, config.scopes.providers, filters),
      [config.scopes.providers, filters, providers],
    );

    const featureRows = useMemo<FeatureScopeRow[]>(
      () =>
        NETWORK_PROXY_FEATURE_KEYS.map((key) => ({
          key,
          scope: config.scopes.features[key] ?? OFF_SCOPE,
        })),
      [config.scopes.features],
    );

    const applyBulk = useCallback(
      (ops: EgressScopeOp[]) =>
        void actions.updateScopes(NETWORK_PROXY_FIELDS.scopesBulk, undefined, ops),
      [actions],
    );

    const onSearch = useCallback((value: string) => {
      setFilters((current) => ({ ...current, name: value }));
    }, []);

    const providerColumns = useProviderScopeColumns({ actions, canManage, filters, onSearch });
    const featureColumns = useFeatureScopeColumns(actions, canManage);

    return (
      <Section description={t('networkProxy.scopes.desc')} title={t('networkProxy.scopes.title')}>
        {providersError ? (
          <Alert
            showIcon
            description={t('networkProxy.scopes.providerLoadFailedDesc')}
            message={t('networkProxy.scopes.providerLoadFailed')}
            type="warning"
            action={
              <Button size="small" onClick={onReloadProviders}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        <FieldStatus
          actions={actions}
          field={NETWORK_PROXY_FIELDS.scopesBulk}
          pendingLabel={t('networkProxy.scopes.bulkSaving')}
        />

        <div className={styles.stack}>
          <div className={styles.toolbarRow}>
            <Text strong>{t('networkProxy.scopes.providersTitle')}</Text>
            <div className={styles.inlineActions}>
              {providerCatalogFailed ? (
                <span className={styles.hintText}>{t('networkProxy.scopes.bulkUnavailable')}</span>
              ) : null}
              <Button
                data-testid="providers-enable-all"
                disabled={bulkDisabled}
                size="small"
                onClick={() => applyBulk([{ enabled: true, providerIds, target: 'all_providers' }])}
              >
                {t('networkProxy.scopes.enableAll')}
              </Button>
              <Button
                data-testid="providers-disable-all"
                disabled={bulkDisabled}
                size="small"
                onClick={() =>
                  applyBulk([{ enabled: false, providerIds, target: 'all_providers' }])
                }
              >
                {t('networkProxy.scopes.disableAll')}
              </Button>
            </div>
          </div>
          <DataTable<ProviderScopeRow>
            columns={providerColumns}
            dataSource={providerRows}
            emptyDescription={t('networkProxy.scopes.providersEmpty')}
            loading={providersLoading}
            pagination={false}
            rowKey="id"
            scroll={{ y: 420 }}
            size="small"
            onChange={({ filters: next }) => {
              // `next.name` also arrives here; the search dropdown already owns that half.
              setFilters((current) => ({
                ...current,
                status: firstColumnFilterValue(next.status),
              }));
            }}
          />
        </div>

        <div className={styles.stack}>
          <div className={styles.toolbarRow}>
            <Text strong>{t('networkProxy.scopes.featuresTitle')}</Text>
            <div className={styles.inlineActions}>
              <Button
                disabled={disabled}
                size="small"
                onClick={() => applyBulk([{ enabled: true, target: 'all_features' }])}
              >
                {t('networkProxy.scopes.enableAll')}
              </Button>
              <Button
                disabled={disabled}
                size="small"
                onClick={() => applyBulk([{ enabled: false, target: 'all_features' }])}
              >
                {t('networkProxy.scopes.disableAll')}
              </Button>
            </div>
          </div>
          <DataTable<FeatureScopeRow>
            columns={featureColumns}
            dataSource={featureRows}
            pagination={false}
            rowKey="key"
            size="small"
          />
        </div>
      </Section>
    );
  },
);

ScopesSection.displayName = 'NetworkProxyScopesSection';

export default ScopesSection;
