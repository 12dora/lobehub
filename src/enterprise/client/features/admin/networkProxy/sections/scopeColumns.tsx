'use client';

import { ProviderIcon } from '@lobehub/icons';
import { Tag, Text } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { featureEgressScope, providerEgressScope } from '@/const/platform/networkProxy';
import type { NetworkProxyOnUnavailable } from '@/types/platform/networkProxy';

import { enumColumnFilter, searchColumnFilter } from '../../primitives/columnFilters';
import FieldStatus from '../FieldStatus';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import {
  BROWSER_DIRECT_PROVIDERS,
  type FeatureScopeRow,
  type ProviderFilters,
  type ProviderScopeRow,
} from './scopeRows';

const controlStackStyle = { display: 'flex', flexDirection: 'column', gap: 4 } as const;

/**
 * The two controls every scope row carries: does this traffic go through the outlet, and what
 * happens when the outlet is down. Each owns its own field id, so a failed save on one row never
 * disables another.
 */
const useScopeControls = (actions: NetworkProxyActions, canManage: boolean) => {
  const { t } = useTranslation('admin');

  const unavailableSelect = useCallback(
    (
      field: string,
      value: NetworkProxyOnUnavailable,
      onChange: (next: NetworkProxyOnUnavailable) => void,
    ): ReactNode => (
      <div style={controlStackStyle}>
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
    (field: string, checked: boolean, onChange: (next: boolean) => void): ReactNode => (
      <div style={controlStackStyle}>
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

  return { scopeSwitch, unavailableSelect };
};

export interface ScopeColumnsOptions {
  actions: NetworkProxyActions;
  canManage: boolean;
  filters: ProviderFilters;
  onSearch: (value: string) => void;
}

export const useProviderScopeColumns = ({
  actions,
  canManage,
  filters,
  onSearch,
}: ScopeColumnsOptions): TableColumnsType<ProviderScopeRow> => {
  const { t } = useTranslation('admin');
  const { scopeSwitch, unavailableSelect } = useScopeControls(actions, canManage);

  return useMemo<TableColumnsType<ProviderScopeRow>>(
    () => [
      {
        dataIndex: 'name',
        key: 'name',
        render: (_: unknown, row) => {
          // The two caveats that survive the 状态 column: neither is a status, both change what
          // switching this row on actually does.
          const caveat = row.delisted
            ? t('networkProxy.scopes.notes.providerDelisted')
            : BROWSER_DIRECT_PROVIDERS.has(row.id)
              ? t('networkProxy.scopes.notes.browserDirect')
              : null;
          return (
            <div style={{ alignItems: 'center', display: 'flex', gap: 8, minWidth: 0 }}>
              <ProviderIcon provider={row.id} size={20} type="avatar" />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Text strong>{row.name}</Text>
                <span className={styles.code}>{row.id}</span>
                {caveat ? <span className={styles.hintText}>{caveat}</span> : null}
              </div>
            </div>
          );
        },
        title: t('networkProxy.scopes.columns.provider'),
        ...searchColumnFilter({
          onSearch,
          placeholder: t('networkProxy.scopes.searchPlaceholder'),
          value: filters.name,
        }),
      },
      {
        key: 'status',
        render: (_: unknown, row) => (
          <Tag color={row.catalogEnabled ? 'success' : 'default'} size="small">
            {t(
              row.catalogEnabled
                ? 'networkProxy.scopes.status.enabled'
                : 'networkProxy.scopes.status.disabled',
            )}
          </Tag>
        ),
        title: t('networkProxy.scopes.columns.status'),
        width: 110,
        ...enumColumnFilter({
          options: [
            { label: t('networkProxy.scopes.status.enabled'), value: 'enabled' },
            { label: t('networkProxy.scopes.status.disabled'), value: 'disabled' },
          ],
          value: filters.status,
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
    ],
    [actions, filters, onSearch, scopeSwitch, t, unavailableSelect],
  );
};

export const useFeatureScopeColumns = (
  actions: NetworkProxyActions,
  canManage: boolean,
): TableColumnsType<FeatureScopeRow> => {
  const { t } = useTranslation('admin');
  const { scopeSwitch, unavailableSelect } = useScopeControls(actions, canManage);

  return useMemo<TableColumnsType<FeatureScopeRow>>(
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
};
