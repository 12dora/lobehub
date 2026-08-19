import type { DropdownItem } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import type { EgressScopeOp } from '@/types/platform/networkProxy';

import type { NetworkProxyActions } from './useNetworkProxyActions';
import { NETWORK_PROXY_FIELDS } from './useNetworkProxyActions';

export interface BuildMoreActionsParams {
  actions: NetworkProxyActions;
  canManage: boolean;
  engineOutlet: boolean;
  providerCatalogFailed: boolean;
  providerIds: string[];
  t: TFunction<'admin'>;
}

/** Overflow-menu items for the 网络代理 tab header (bulk scopes, latency, restart). */
export const buildMoreActions = ({
  actions,
  canManage,
  engineOutlet,
  providerCatalogFailed,
  providerIds,
  t,
}: BuildMoreActionsParams): DropdownItem[] => {
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
};
