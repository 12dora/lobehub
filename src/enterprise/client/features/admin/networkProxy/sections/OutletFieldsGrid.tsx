'use client';

import { Segmented, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  NETWORK_PROXY_LIMITS,
  NETWORK_PROXY_OUTLET_MODES,
  NETWORK_PROXY_RULE_MODES,
} from '@/const/platform/networkProxy';
import type {
  NetworkProxyConfigView,
  NetworkProxyOutletKind,
  NetworkProxyOutletMode,
  NetworkProxyRuleMode,
} from '@/types/platform/networkProxy';

import { applyConfigPatch, patchOutlet } from '../configUpdate';
import FieldStatus from '../FieldStatus';
import type { NetworkProxyGeodataState } from '../geodataState';
import { Field } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import { CommitInput, CommitNumber } from './CommitFields';

export interface OutletFieldsGridProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  config: NetworkProxyConfigView;
  /** Smart routing stays locked until both rule files are installed on this instance. */
  geodataState: NetworkProxyGeodataState;
}

/**
 * The outlet's own settings: where traffic leaves from, how a node is picked, which rule set
 * decides what is routed, and how the latency probe is run. Every control saves on change and
 * carries its own status line — a failed latency-URL save must not freeze the outlet switch.
 */
const OutletFieldsGrid = memo<OutletFieldsGridProps>(
  ({ actions, canManage, config, geodataState }) => {
    const { t } = useTranslation('admin');
    const F = NETWORK_PROXY_FIELDS;
    const lock = (field: string) => !canManage || actions.isBusy(field);
    const outletKind = actions.valueOf(F.outletKind, config.outlet.kind);
    const outletMode = actions.valueOf(F.outletMode, config.outlet.mode);
    const ruleMode = actions.valueOf(F.ruleMode, config.ruleMode);
    const engineOutlet = outletKind === 'engine';

    return (
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
              disabled: mode === 'smart' && geodataState !== 'ready',
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
    );
  },
);

OutletFieldsGrid.displayName = 'NetworkProxyOutletFieldsGrid';

export default OutletFieldsGrid;
