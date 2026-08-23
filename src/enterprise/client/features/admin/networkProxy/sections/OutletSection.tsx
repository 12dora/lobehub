'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type { AdminNetworkProxyNodes } from '@/enterprise/client/services/adminNetworkProxy';
import type { NetworkProxyConfigView, SubscriptionView } from '@/types/platform/networkProxy';

import { applyConfigPatch } from '../configUpdate';
import FieldStatus from '../FieldStatus';
import { formatDelay } from '../format';
import type { NetworkProxyGeodataState } from '../geodataState';
import { Field, Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import NodesTable from './NodesTable';
import OutletFieldsGrid from './OutletFieldsGrid';
import OutletStaticProxy from './OutletStaticProxy';

export interface OutletSectionProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  config: NetworkProxyConfigView;
  /**
   * Smart routing needs both rule files installed on this instance. `unknown` means the status
   * query gave no answer — the option stays locked, but nothing is offered or claimed.
   */
  geodataState: NetworkProxyGeodataState;
  nodes?: AdminNetworkProxyNodes;
  nodesError?: unknown;
  nodesLoading?: boolean;
  /** Install the smart-routing rule data without leaving this block. */
  onInstallGeodata?: () => void;
  onReloadNodes: () => void;
  subscriptions: SubscriptionView[];
}

/**
 * 出口与节点 (design §6.2).
 *
 * Everything here changes where the whole platform's scoped traffic leaves from, so each control
 * is saved the moment it is changed, owns its own failure state, and every disabled control says
 * why it is disabled.
 */
const OutletSection = memo<OutletSectionProps>(
  ({
    actions,
    canManage,
    config,
    geodataState,
    nodes,
    nodesError,
    nodesLoading,
    onInstallGeodata,
    onReloadNodes,
    subscriptions,
  }) => {
    const { t } = useTranslation('admin');
    const F = NETWORK_PROXY_FIELDS;
    // Per-field lock: a failed latency-URL save must not freeze the outlet switch.
    const lock = (field: string) => !canManage || actions.isBusy(field);
    const outletKind = actions.valueOf(F.outletKind, config.outlet.kind);
    const outletMode = actions.valueOf(F.outletMode, config.outlet.mode);
    const engineOutlet = outletKind === 'engine';
    const connectivity = actions.lastConnectivity;
    const connectivityEntry = actions.entryOf(F.connectivity);
    const staticProxyEntry = actions.entryOf(F.staticProxy);
    // An unresolved static-proxy write must keep its form (and its Retry / Discard) on screen even
    // when the winning config no longer has a static proxy — otherwise "Retry all" would re-send
    // an endpoint and credentials nobody can see.
    const staticProxyUnresolved =
      staticProxyEntry !== undefined && staticProxyEntry.status !== 'success';
    const showStaticProxy = !engineOutlet || Boolean(config.staticProxy) || staticProxyUnresolved;

    return (
      <Section
        description={t('networkProxy.outlet.desc')}
        title={t('networkProxy.outlet.title')}
        actions={
          <Button
            disabled={lock(F.connectivity)}
            loading={actions.isBusy(F.connectivity)}
            size="small"
            onClick={() => void actions.testConnectivity()}
          >
            {t('networkProxy.outlet.testConnectivity')}
          </Button>
        }
      >
        {connectivityEntry?.status === 'success' && connectivity?.ok ? (
          <Alert
            showIcon
            type="success"
            message={t('networkProxy.outlet.connectivityOk', {
              delay: formatDelay(connectivity.latencyMs),
              ip: connectivity.egressIp ?? t('networkProxy.outlet.egressIpUnknown'),
            })}
          />
        ) : null}
        {connectivityEntry?.status === 'error' || connectivityEntry?.status === 'conflict' ? (
          <Alert
            showIcon
            description={t('networkProxy.outlet.connectivityFailedDesc')}
            message={t('networkProxy.outlet.connectivityFailed')}
            type="error"
            action={
              <Button size="small" onClick={() => void actions.testConnectivity()}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        <OutletFieldsGrid
          actions={actions}
          canManage={canManage}
          config={config}
          geodataState={geodataState}
        />

        {/* Smart routing stays disabled until the rule data is there — but the way to get it is
            right here, rather than a dead end pointing at another block. It is only offered once
            we know the data is actually missing; an unread status says nothing about the disk. */}
        {geodataState === 'unknown' ? (
          <Text className={styles.hintText}>{t('networkProxy.outlet.geodataUnknown')}</Text>
        ) : null}
        {geodataState === 'missing' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div className={styles.inlineActions}>
              <Text className={styles.hintText}>{t('networkProxy.outlet.geodataInstallHint')}</Text>
              {onInstallGeodata ? (
                <Button
                  disabled={lock(F.installGeodata)}
                  loading={actions.isBusy(F.installGeodata)}
                  size="small"
                  onClick={onInstallGeodata}
                >
                  {t('networkProxy.outlet.geodataInstallAction')}
                </Button>
              ) : null}
            </div>
            <FieldStatus
              actions={actions}
              field={F.installGeodata}
              pendingLabel={t('networkProxy.engine.geodata.installing')}
            />
          </div>
        ) : null}

        <Field
          hint={t('networkProxy.outlet.bypassHostsHint')}
          label={t('networkProxy.outlet.bypassHosts')}
        >
          <Select
            disabled={lock(F.bypassHosts)}
            mode="tags"
            placeholder={t('networkProxy.outlet.bypassHostsPlaceholder')}
            style={{ maxWidth: 640, width: '100%' }}
            value={actions.valueOf(F.bypassHosts, config.bypassHosts)}
            options={actions
              .valueOf(F.bypassHosts, config.bypassHosts)
              .map((host) => ({ label: host, value: host }))}
            onChange={(next) => {
              const hosts = (Array.isArray(next) ? next : [])
                .map((item) => String(item).trim())
                .filter(Boolean)
                .slice(0, NETWORK_PROXY_LIMITS.BYPASS_HOSTS_MAX);
              void actions.patchConfig(F.bypassHosts, hosts, (base) =>
                applyConfigPatch(base.config, { bypassHosts: hosts }),
              );
            }}
          />
          <FieldStatus actions={actions} field={F.bypassHosts} />
        </Field>

        <div className={styles.toolbarRow}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <Text strong style={{ fontSize: 13 }}>
              {t('networkProxy.outlet.subscriptionViaOutlet')}
            </Text>
            <span className={styles.hintText}>
              {t('networkProxy.outlet.subscriptionViaOutletHint')}
            </span>
            <FieldStatus actions={actions} field={F.subscriptionUpdateViaOutlet} />
          </div>
          <Switch
            disabled={lock(F.subscriptionUpdateViaOutlet)}
            checked={actions.valueOf(
              F.subscriptionUpdateViaOutlet,
              config.subscriptionUpdateViaOutlet,
            )}
            onChange={(checked) =>
              void actions.patchConfig(F.subscriptionUpdateViaOutlet, Boolean(checked), (base) =>
                applyConfigPatch(base.config, {
                  subscriptionUpdateViaOutlet: Boolean(checked),
                }),
              )
            }
          />
        </div>

        {showStaticProxy ? (
          <OutletStaticProxy actions={actions} canManage={canManage} config={config} />
        ) : null}

        {engineOutlet ? (
          <>
            <FieldStatus
              actions={actions}
              field={F.selectNode}
              pendingLabel={t('networkProxy.nodes.selecting')}
            />
            <NodesTable
              actions={actions}
              canManage={canManage}
              data={nodes}
              error={nodesError}
              loading={nodesLoading}
              manualNodeName={actions.valueOf(F.selectNode, config.outlet.manualNodeName)}
              manualSelection={outletMode === 'manual'}
              subscriptions={subscriptions}
              onRetry={onReloadNodes}
            />
          </>
        ) : (
          <Text className={styles.hintText}>{t('networkProxy.outlet.staticNoNodes')}</Text>
        )}
      </Section>
    );
  },
);

OutletSection.displayName = 'NetworkProxyOutletSection';

export default OutletSection;
