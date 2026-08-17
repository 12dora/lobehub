'use client';

import { ProviderIcon } from '@lobehub/icons';
import { Alert, Text } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  featureEgressScope,
  NETWORK_PROXY_FEATURE_KEYS,
  providerEgressScope,
} from '@/const/platform/networkProxy';
import type {
  EgressScopeOp,
  EgressScopeState,
  NetworkProxyConfigView,
  NetworkProxyFeatureKey,
  NetworkProxyOnUnavailable,
} from '@/types/platform/networkProxy';

import { searchColumnFilter } from '../../primitives/columnFilters';
import DataTable from '../../primitives/DataTable';
import FieldStatus from '../FieldStatus';
import type { NetworkProxyProviderOption } from '../hooks';
import { Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';

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

interface ProviderScopeRow {
  catalogEnabled: boolean;
  /** True when the provider only exists because it still carries a scope. */
  delisted: boolean;
  id: string;
  name: string;
  scope: EgressScopeState;
}

interface FeatureScopeRow {
  key: NetworkProxyFeatureKey;
  scope: EgressScopeState;
}

const OFF_SCOPE: EgressScopeState = { enabled: false, onUnavailable: 'direct' };

/**
 * Providers that the server-side runtime cannot route because the browser talks to them
 * directly (design §3.5). Ollama with `fetchOnClient` is the only case today.
 */
const BROWSER_DIRECT_PROVIDERS = new Set(['ollama']);

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
    const [search, setSearch] = useState<string | undefined>();
    const bulkBusy = actions.isBusy(NETWORK_PROXY_FIELDS.scopesBulk);
    const disabled = !canManage || bulkBusy;
    // Without the full catalog a bulk write would burn a revision while leaving providers we
    // cannot see untouched — which reads as "route none" having silently failed.
    const bulkDisabled = disabled || providerCatalogFailed;

    const providerRows = useMemo<ProviderScopeRow[]>(() => {
      const known = new Map(providers.map((provider) => [provider.id, provider]));
      const rows: ProviderScopeRow[] = [...known.values()].map((provider) => ({
        catalogEnabled: provider.enabled,
        delisted: false,
        id: provider.id,
        name: provider.name,
        scope: config.scopes.providers[provider.id] ?? OFF_SCOPE,
      }));
      // A provider that was scoped and later removed from the catalog must stay visible —
      // otherwise its switch would be stuck on with no way to turn it off.
      for (const [id, scope] of Object.entries(config.scopes.providers)) {
        if (known.has(id)) continue;
        rows.push({ catalogEnabled: false, delisted: true, id, name: id, scope });
      }
      const needle = search?.trim().toLowerCase();
      return needle
        ? rows.filter(
            (row) =>
              row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle),
          )
        : rows;
    }, [config.scopes.providers, providers, search]);

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

    const unavailableSelect = useCallback(
      (
        field: string,
        value: NetworkProxyOnUnavailable,
        onChange: (next: NetworkProxyOnUnavailable) => void,
      ) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Select
            disabled={!canManage || actions.isBusy(field)}
            style={{ width: 160 }}
            value={actions.valueOf(field, value)}
            options={[
              { label: t('networkProxy.scopes.onUnavailable.direct'), value: 'direct' },
              { label: t('networkProxy.scopes.onUnavailable.fail'), value: 'fail' },
            ]}
            onChange={(next) => onChange(next as NetworkProxyOnUnavailable)}
          />
          <FieldStatus actions={actions} field={field} />
        </div>
      ),
      [actions, canManage, t],
    );

    const scopeSwitch = useCallback(
      (field: string, checked: boolean, onChange: (next: boolean) => void) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Switch
            checked={actions.valueOf(field, checked)}
            disabled={!canManage || actions.isBusy(field)}
            onChange={(next) => onChange(Boolean(next))}
          />
          <FieldStatus actions={actions} field={field} />
        </div>
      ),
      [actions, canManage],
    );

    const providerColumns = useMemo<TableColumnsType<ProviderScopeRow>>(
      () => [
        {
          dataIndex: 'name',
          key: 'name',
          render: (_: unknown, row) => (
            <div style={{ alignItems: 'center', display: 'flex', gap: 8, minWidth: 0 }}>
              <ProviderIcon provider={row.id} size={20} type="avatar" />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Text strong>{row.name}</Text>
                <span className={styles.code}>{row.id}</span>
              </div>
            </div>
          ),
          title: t('networkProxy.scopes.columns.provider'),
          ...searchColumnFilter({
            onSearch: setSearch,
            placeholder: t('networkProxy.scopes.searchPlaceholder'),
            value: search,
          }),
        },
        {
          key: 'enabled',
          render: (_: unknown, row) => {
            const scope = providerEgressScope(row.id);
            return scopeSwitch(
              NETWORK_PROXY_FIELDS.scope(scope, 'enabled'),
              row.scope.enabled,
              (next) =>
                void actions.updateScopes(NETWORK_PROXY_FIELDS.scope(scope, 'enabled'), next, [
                  { enabled: next, scope, target: 'one' },
                ]),
            );
          },
          title: t('networkProxy.scopes.columns.enabled'),
          width: 120,
        },
        {
          key: 'onUnavailable',
          render: (_: unknown, row) => {
            const scope = providerEgressScope(row.id);
            const field = NETWORK_PROXY_FIELDS.scope(scope, 'onUnavailable');
            return unavailableSelect(
              field,
              row.scope.onUnavailable,
              (next) =>
                void actions.updateScopes(field, next, [
                  { onUnavailable: next, scope, target: 'one' },
                ]),
            );
          },
          title: t('networkProxy.scopes.columns.onUnavailable'),
          width: 200,
        },
        {
          key: 'note',
          render: (_: unknown, row) => {
            const notes: string[] = [];
            if (BROWSER_DIRECT_PROVIDERS.has(row.id)) {
              notes.push(t('networkProxy.scopes.notes.browserDirect'));
            }
            if (row.delisted) notes.push(t('networkProxy.scopes.notes.providerDelisted'));
            else if (!row.catalogEnabled) {
              notes.push(t('networkProxy.scopes.notes.providerDisabled'));
            }
            return notes.length > 0 ? (
              <span className={styles.hintText}>{notes.join(' · ')}</span>
            ) : (
              '—'
            );
          },
          title: t('networkProxy.scopes.columns.note'),
        },
      ],
      [actions, scopeSwitch, search, t, unavailableSelect],
    );

    const featureColumns = useMemo<TableColumnsType<FeatureScopeRow>>(
      () => [
        {
          dataIndex: 'key',
          key: 'key',
          render: (_: unknown, row) => (
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Text strong>{t(`networkProxy.feature.${row.key}` as never)}</Text>
              <span className={styles.hintText}>
                {t(`networkProxy.featureDesc.${row.key}` as never)}
              </span>
            </div>
          ),
          title: t('networkProxy.scopes.columns.feature'),
        },
        {
          key: 'enabled',
          render: (_: unknown, row) => {
            const scope = featureEgressScope(row.key);
            return scopeSwitch(
              NETWORK_PROXY_FIELDS.scope(scope, 'enabled'),
              row.scope.enabled,
              (next) =>
                void actions.updateScopes(NETWORK_PROXY_FIELDS.scope(scope, 'enabled'), next, [
                  { enabled: next, scope, target: 'one' },
                ]),
            );
          },
          title: t('networkProxy.scopes.columns.enabled'),
          width: 120,
        },
        {
          key: 'onUnavailable',
          render: (_: unknown, row) => {
            const scope = featureEgressScope(row.key);
            const field = NETWORK_PROXY_FIELDS.scope(scope, 'onUnavailable');
            return unavailableSelect(
              field,
              row.scope.onUnavailable,
              (next) =>
                void actions.updateScopes(field, next, [
                  { onUnavailable: next, scope, target: 'one' },
                ]),
            );
          },
          title: t('networkProxy.scopes.columns.onUnavailable'),
          width: 200,
        },
      ],
      [actions, scopeSwitch, t, unavailableSelect],
    );

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
