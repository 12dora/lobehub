'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button, Input, InputNumber, Segmented, Select, Switch } from '@lobehub/ui/base-ui';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  NETWORK_PROXY_LIMITS,
  NETWORK_PROXY_OUTLET_MODES,
  NETWORK_PROXY_RULE_MODES,
} from '@/const/platform/networkProxy';
import type { AdminNetworkProxyNodes } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  NetworkProxyConfigView,
  NetworkProxyOutletKind,
  NetworkProxyOutletMode,
  NetworkProxyRuleMode,
  StaticProxyUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import { applyConfigPatch, patchOutlet, patchStaticProxy } from '../configUpdate';
import FieldStatus from '../FieldStatus';
import { formatDelay } from '../format';
import { Field, Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import NodesTable from './NodesTable';
import StaticProxyForm from './StaticProxyForm';

export interface OutletSectionProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  config: NetworkProxyConfigView;
  /** Smart routing needs both geodata files installed on this instance. */
  geodataReady: boolean;
  nodes?: AdminNetworkProxyNodes;
  nodesError?: unknown;
  nodesLoading?: boolean;
  onReloadNodes: () => void;
  subscriptions: SubscriptionView[];
}

/** Text field that saves on blur / Enter — instant save without a write per keystroke. */
const CommitInput = memo<{
  disabled: boolean;
  onCommit: (value: string) => void;
  placeholder?: string;
  value: string;
}>(({ disabled, onCommit, placeholder, value }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <Input
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
});
CommitInput.displayName = 'NetworkProxyCommitInput';

const CommitNumber = memo<{
  disabled: boolean;
  max: number;
  min: number;
  onCommit: (value: number) => void;
  value: number;
}>(({ disabled, max, min, onCommit, value }) => {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === null || !Number.isFinite(draft) || draft < min || draft > max) {
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <InputNumber
      disabled={disabled}
      max={max}
      min={min}
      value={draft}
      onBlur={commit}
      onChange={(next) => setDraft(next)}
    />
  );
});
CommitNumber.displayName = 'NetworkProxyCommitNumber';

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
    geodataReady,
    nodes,
    nodesError,
    nodesLoading,
    onReloadNodes,
    subscriptions,
  }) => {
    const { t } = useTranslation('admin');
    const F = NETWORK_PROXY_FIELDS;
    // Per-field lock: a failed latency-URL save must not freeze the outlet switch.
    const lock = (field: string) => !canManage || actions.isBusy(field);
    const outletKind = actions.valueOf(F.outletKind, config.outlet.kind);
    const outletMode = actions.valueOf(F.outletMode, config.outlet.mode);
    const ruleMode = actions.valueOf(F.ruleMode, config.ruleMode);
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

        <div className={styles.fieldGrid}>
          <Field hint={t('networkProxy.outlet.kindHint')} label={t('networkProxy.outlet.kind')}>
            <Segmented
              disabled={lock(F.outletKind)}
              value={outletKind}
              options={[
                { label: t('networkProxy.outlet.kindEngine'), value: 'engine' },
                { label: t('networkProxy.outlet.kindStatic'), value: 'static' },
              ]}
              onChange={(next) =>
                void actions.patchConfig(F.outletKind, next as NetworkProxyOutletKind, (base) =>
                  patchOutlet(base.config, { kind: next as NetworkProxyOutletKind }),
                )
              }
            />
            <FieldStatus actions={actions} field={F.outletKind} />
          </Field>

          <Field hint={t('networkProxy.outlet.modeHint')} label={t('networkProxy.outlet.mode')}>
            <Select
              disabled={lock(F.outletMode) || !engineOutlet}
              style={{ width: 200 }}
              value={outletMode}
              options={NETWORK_PROXY_OUTLET_MODES.map((mode) => ({
                label: t(`networkProxy.outletMode.${mode}` as never),
                value: mode,
              }))}
              onChange={(next) =>
                void actions.patchConfig(F.outletMode, next as NetworkProxyOutletMode, (base) =>
                  patchOutlet(base.config, { mode: next as NetworkProxyOutletMode }),
                )
              }
            />
            <FieldStatus actions={actions} field={F.outletMode} />
          </Field>

          <Field
            hint={t('networkProxy.outlet.ruleModeHint')}
            label={t('networkProxy.outlet.ruleMode')}
          >
            <Segmented
              disabled={lock(F.ruleMode)}
              value={ruleMode}
              options={NETWORK_PROXY_RULE_MODES.map((mode) => ({
                disabled: mode === 'smart' && !geodataReady,
                label: t(`networkProxy.ruleMode.${mode}` as never),
                value: mode,
              }))}
              onChange={(next) =>
                void actions.patchConfig(F.ruleMode, next as NetworkProxyRuleMode, (base) =>
                  applyConfigPatch(base.config, { ruleMode: next as NetworkProxyRuleMode }),
                )
              }
            />
            <FieldStatus actions={actions} field={F.ruleMode} />
          </Field>

          <Field
            hint={t('networkProxy.outlet.latencyUrlHint')}
            label={t('networkProxy.outlet.latencyUrl')}
          >
            <CommitInput
              disabled={lock(F.outletLatencyUrl)}
              value={actions.valueOf(F.outletLatencyUrl, config.outlet.latencyTestUrl)}
              onCommit={(value) =>
                void actions.patchConfig(F.outletLatencyUrl, value, (base) =>
                  patchOutlet(base.config, { latencyTestUrl: value }),
                )
              }
            />
            <FieldStatus actions={actions} field={F.outletLatencyUrl} />
          </Field>

          <Field label={t('networkProxy.outlet.latencyInterval')}>
            <CommitNumber
              disabled={lock(F.outletLatencyInterval)}
              max={NETWORK_PROXY_LIMITS.LATENCY_INTERVAL_MAX_SEC}
              min={NETWORK_PROXY_LIMITS.LATENCY_INTERVAL_MIN_SEC}
              value={actions.valueOf(F.outletLatencyInterval, config.outlet.latencyIntervalSec)}
              onCommit={(value) =>
                void actions.patchConfig(F.outletLatencyInterval, value, (base) =>
                  patchOutlet(base.config, { latencyIntervalSec: value }),
                )
              }
            />
            <FieldStatus actions={actions} field={F.outletLatencyInterval} />
          </Field>

          {outletMode === 'auto' ? (
            <Field
              hint={t('networkProxy.outlet.toleranceHint')}
              label={t('networkProxy.outlet.tolerance')}
            >
              <CommitNumber
                disabled={lock(F.outletTolerance)}
                max={5000}
                min={0}
                value={actions.valueOf(F.outletTolerance, config.outlet.toleranceMs)}
                onCommit={(value) =>
                  void actions.patchConfig(F.outletTolerance, value, (base) =>
                    patchOutlet(base.config, { toleranceMs: value }),
                  )
                }
              />
              <FieldStatus actions={actions} field={F.outletTolerance} />
            </Field>
          ) : null}
        </div>

        {!geodataReady ? (
          <Text className={styles.hintText}>{t('networkProxy.outlet.geodataNotReady')}</Text>
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
          <div className={styles.stack}>
            <Text strong style={{ fontSize: 13 }}>
              {t('networkProxy.outlet.staticTitle')}
            </Text>
            <StaticProxyForm
              busy={actions.isBusy(F.staticProxy)}
              disabled={lock(F.staticProxy)}
              value={config.staticProxy}
              // The exact submission is the draft, so a conflict keeps the endpoint and the
              // password instruction the admin entered on screen, and Retry re-sends that.
              pendingDraft={actions.valueOf<StaticProxyUpdate | null | undefined>(
                F.staticProxy,
                undefined,
              )}
              onRemove={() =>
                void actions.patchConfig(F.staticProxy, null, (base) =>
                  patchStaticProxy(base.config, null),
                )
              }
              onSubmit={(value: StaticProxyUpdate) =>
                void actions.patchConfig(F.staticProxy, value, (base) =>
                  patchStaticProxy(base.config, value),
                )
              }
            />
            <FieldStatus actions={actions} field={F.staticProxy} />
            <div className={styles.toolbarRow}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <Text strong style={{ fontSize: 13 }}>
                  {t('networkProxy.outlet.downloadViaStatic')}
                </Text>
                <span className={styles.hintText}>
                  {t('networkProxy.outlet.downloadViaStaticHint')}
                </span>
                <FieldStatus actions={actions} field={F.downloadViaStaticProxy} />
              </div>
              <Switch
                checked={actions.valueOf(F.downloadViaStaticProxy, config.downloadViaStaticProxy)}
                disabled={lock(F.downloadViaStaticProxy) || !config.staticProxy}
                onChange={(checked) =>
                  void actions.patchConfig(F.downloadViaStaticProxy, Boolean(checked), (base) =>
                    applyConfigPatch(base.config, { downloadViaStaticProxy: Boolean(checked) }),
                  )
                }
              />
            </div>
          </div>
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
