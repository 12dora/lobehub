'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button, DropdownMenu, Switch } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { InstanceStatusView, OutletStatusView } from '@/types/platform/networkProxy';

import { buildMoreActions } from './buildMoreActions';
import { applyConfigPatch } from './configUpdate';
import FieldStatus from './FieldStatus';
import { formatDelay } from './format';
import { networkProxyStyles as styles } from './styles';
import type { NetworkProxyActions } from './useNetworkProxyActions';
import { NETWORK_PROXY_FIELDS } from './useNetworkProxyActions';

export interface NetworkProxyHeaderProps {
  actions: NetworkProxyActions;
  appliedCount: number;
  canManage: boolean;
  current?: InstanceStatusView;
  engineOutlet: boolean;
  globalProxyActive: boolean;
  instances: InstanceStatusView[];
  masterEnabled: boolean;
  outlet?: OutletStatusView;
  providerCatalogFailed: boolean;
  providerIds: string[];
  statusStale: boolean;
  statusUnknown: boolean;
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
 * Master switch, live-status badges, and the overflow menu for bulk / latency / restart.
 */
const NetworkProxyHeader = memo<NetworkProxyHeaderProps>(
  ({
    actions,
    appliedCount,
    canManage,
    current,
    engineOutlet,
    globalProxyActive,
    instances,
    masterEnabled,
    outlet,
    providerCatalogFailed,
    providerIds,
    statusStale,
    statusUnknown,
  }) => {
    const { t } = useTranslation('admin');
    const masterLocked = globalProxyActive || !canManage;
    const masterChecked = actions.valueOf(NETWORK_PROXY_FIELDS.master, masterEnabled);

    const moreActions = useMemo(
      () =>
        buildMoreActions({
          actions,
          canManage,
          engineOutlet,
          providerCatalogFailed,
          providerIds,
          t,
        }),
      [actions, canManage, engineOutlet, providerCatalogFailed, providerIds, t],
    );

    return (
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
    );
  },
);

NetworkProxyHeader.displayName = 'NetworkProxyHeader';

export default NetworkProxyHeader;
