'use client';

import { Text } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { NetworkProxyConfigView, StaticProxyUpdate } from '@/types/platform/networkProxy';

import { applyConfigPatch, patchStaticProxy } from '../configUpdate';
import FieldStatus from '../FieldStatus';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import StaticProxyForm from './StaticProxyForm';

export interface OutletStaticProxyProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  config: NetworkProxyConfigView;
}

/** The upstream HTTP/SOCKS proxy, and whether artifact downloads are routed through it too. */
const OutletStaticProxy = memo<OutletStaticProxyProps>(({ actions, canManage, config }) => {
  const { t } = useTranslation('admin');
  const F = NETWORK_PROXY_FIELDS;
  const lock = (field: string) => !canManage || actions.isBusy(field);

  return (
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
          <span className={styles.hintText}>{t('networkProxy.outlet.downloadViaStaticHint')}</span>
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
  );
});

OutletStaticProxy.displayName = 'NetworkProxyOutletStaticProxy';

export default OutletStaticProxy;
