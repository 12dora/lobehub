'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArtifactStatusView,
  InstanceStatusView,
  NetworkProxyConfigView,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';

import { networkProxyStyles as styles } from './styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from './useNetworkProxyActions';

export interface NetworkProxyBannersProps {
  actions: NetworkProxyActions;
  artifacts?: ArtifactStatusView;
  /** The artifact query failed and has no cached answer — install state is unknown, not absent. */
  artifactsError?: unknown;
  /** The artifact query failed but a cached answer is on screen — it is old, not wrong. */
  artifactsStale?: boolean;
  canManage: boolean;
  config: NetworkProxyConfigView;
  geodataReady: boolean;
  globalProxyActive: boolean;
  onReloadArtifacts: () => void;
  onReloadStatus: () => void;
  status?: NetworkProxyStatusView;
  /** The status query failed and has no cached answer — the engine is not "down", it is unknown. */
  statusError?: unknown;
  /** The status poll is failing while the last known state is still displayed. */
  statusStale?: boolean;
}

const engineErrorInstance = (instances: InstanceStatusView[]): InstanceStatusView | undefined =>
  instances.find((instance) => instance.engineState === 'error') ??
  instances.find((instance) => Boolean(instance.lastError));

/**
 * Every failure state on this page, stated as "what is happening / what to do" (DESIGN.md,
 * 确定性). Ordered by how much of the platform each one affects.
 *
 * A failed *query* is reported as unknown state with a Retry — never as a healthy-looking
 * "not installed / no nodes", which would send an admin chasing an outage that is not there.
 */
const NetworkProxyBanners = memo<NetworkProxyBannersProps>(
  ({
    actions,
    artifacts,
    artifactsError,
    artifactsStale,
    canManage,
    config,
    geodataReady,
    globalProxyActive,
    onReloadArtifacts,
    onReloadStatus,
    status,
    statusError,
    statusStale,
  }) => {
    const { t } = useTranslation('admin');
    const instances = status?.instances ?? [];
    const broken = engineErrorInstance(instances);
    const fallbackScopes = status?.fallbackScopes ?? [];
    const conflictCount = actions.conflicts.length;

    return (
      <>
        {conflictCount > 0 ? (
          <Alert
            showIcon
            description={t('networkProxy.conflict.desc', { count: conflictCount })}
            message={t('networkProxy.conflict.title')}
            type="warning"
            action={
              <div className={styles.inlineActions}>
                <Button size="small" onClick={() => void actions.retryAll()}>
                  {t('networkProxy.conflict.retryAll')}
                </Button>
                <Button size="small" onClick={actions.dismissAll}>
                  {t('networkProxy.conflict.dismissAll')}
                </Button>
              </div>
            }
          />
        ) : null}

        {globalProxyActive ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.globalProxyDesc')}
            message={t('networkProxy.banners.globalProxy')}
            type="warning"
          />
        ) : null}

        {statusError && !status ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.statusUnknownDesc')}
            message={t('networkProxy.banners.statusUnknown')}
            type="error"
            action={
              <Button size="small" onClick={onReloadStatus}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        {artifactsError && !artifacts ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.artifactsUnknownDesc')}
            message={t('networkProxy.banners.artifactsUnknown')}
            type="error"
            action={
              <Button size="small" onClick={onReloadArtifacts}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        {statusStale ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.statusStaleDesc')}
            message={t('networkProxy.banners.statusStale')}
            type="warning"
            action={
              <Button size="small" onClick={onReloadStatus}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        {artifactsStale ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.artifactsStaleDesc')}
            message={t('networkProxy.banners.artifactsStale')}
            type="warning"
            action={
              <Button size="small" onClick={onReloadArtifacts}>
                {t('networkProxy.actions.retry')}
              </Button>
            }
          />
        ) : null}

        {artifacts && !artifacts.engine.supported ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.unsupportedDesc')}
            message={t('networkProxy.banners.unsupported')}
            type="warning"
          />
        ) : null}

        {broken ? (
          <Alert
            showIcon
            description={broken.lastError ?? t('networkProxy.banners.engineErrorDescFallback')}
            message={t('networkProxy.banners.engineError', { instance: broken.instanceId })}
            type="error"
            action={
              <Button
                disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
                loading={actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
                size="small"
                onClick={() => void actions.restartEngine()}
              >
                {t('networkProxy.engine.restart')}
              </Button>
            }
          />
        ) : null}

        {fallbackScopes.length > 0 ? (
          <Alert
            showIcon
            message={t('networkProxy.banners.fallback')}
            type="warning"
            description={t('networkProxy.banners.fallbackDesc', {
              scopes: fallbackScopes.join(', '),
            })}
          />
        ) : null}

        {/* Only claim geodata is missing when we actually know what is installed. */}
        {config.ruleMode === 'smart' && !geodataReady && !(artifactsError && !artifacts) ? (
          <Alert
            showIcon
            description={t('networkProxy.banners.geodataDesc')}
            message={t('networkProxy.banners.geodata')}
            type="info"
          />
        ) : null}
      </>
    );
  },
);

NetworkProxyBanners.displayName = 'NetworkProxyBanners';

export default NetworkProxyBanners;
