'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { Fragment, memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArtifactStatusView,
  NetworkProxyConfigView,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';

import {
  groupEngineInstances,
  healingOf,
  LIVE_STATES,
  type NetworkProxyBannerState,
  resolveNetworkProxyBanners,
} from './bannerState';
import { useCountdown, useSelfHealed } from './bannerTimers';
import type { NetworkProxyGeodataState } from './geodataState';
import IssueDescription from './IssueDescription';
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
  /** `unknown` means the status query gave no answer — never claim the data is missing then. */
  geodataState: NetworkProxyGeodataState;
  globalProxyActive: boolean;
  onInstallGeodata: () => void;
  onReloadArtifacts: () => void;
  onReloadStatus: () => void;
  status?: NetworkProxyStatusView;
  /** The status query failed and has no cached answer — the engine is not "down", it is unknown. */
  statusError?: unknown;
  /** The status poll is failing while the last known state is still displayed. */
  statusStale?: boolean;
}

/** Everything the banner copy needs beyond the resolved state itself. */
interface BannerRenderContext {
  actions: NetworkProxyActions;
  canManage: boolean;
  onInstallGeodata: () => void;
  onReloadArtifacts: () => void;
  onReloadStatus: () => void;
  restartAction: ReactNode;
  t: TFunction<'admin'>;
}

const stackStyle = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } as const;

/**
 * One banner per resolved state (see `bannerState.ts` for the precedence). Each case only says
 * "what is happening / what to do" (DESIGN.md, 确定性) — the decision of *whether* it shows was
 * already taken by the resolver.
 */
const renderBanner = (state: NetworkProxyBannerState, ctx: BannerRenderContext): ReactNode => {
  const { actions, canManage, t } = ctx;
  switch (state.kind) {
    case 'conflict': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.conflict.desc', { count: state.count })}
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
      );
    }
    case 'globalProxy': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.globalProxyDesc')}
          message={t('networkProxy.banners.globalProxy')}
          type="warning"
        />
      );
    }
    case 'statusUnknown': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.statusUnknownDesc')}
          message={t('networkProxy.banners.statusUnknown')}
          type="error"
          action={
            <Button size="small" onClick={ctx.onReloadStatus}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      );
    }
    case 'artifactsUnknown': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.artifactsUnknownDesc')}
          message={t('networkProxy.banners.artifactsUnknown')}
          type="error"
          action={
            <Button size="small" onClick={ctx.onReloadArtifacts}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      );
    }
    case 'statusStale': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.statusStaleDesc')}
          message={t('networkProxy.banners.statusStale')}
          type="warning"
          action={
            <Button size="small" onClick={ctx.onReloadStatus}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      );
    }
    case 'artifactsStale': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.artifactsStaleDesc')}
          message={t('networkProxy.banners.artifactsStale')}
          type="warning"
          action={
            <Button size="small" onClick={ctx.onReloadArtifacts}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      );
    }
    case 'unsupported': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.unsupportedDesc')}
          message={t('networkProxy.banners.unsupported')}
          type="warning"
        />
      );
    }
    case 'selfHealed': {
      return <Alert showIcon message={t('networkProxy.banners.selfHealed')} type="success" />;
    }
    case 'engineIssue': {
      return (
        <Alert
          showIcon
          action={ctx.restartAction}
          type="error"
          description={
            <div style={stackStyle}>
              <IssueDescription issue={state.issue} />
              {/* The recovering instances are real, but they are not what this banner is
                  asking the admin to act on. */}
              {state.healingCount > 0 ? (
                <span>
                  {t('networkProxy.banners.selfHealingAlso', { count: state.healingCount })}
                </span>
              ) : null}
            </div>
          }
          message={
            state.terminalCount > 1
              ? t('networkProxy.banners.engineIssueMulti', { count: state.terminalCount })
              : t('networkProxy.banners.engineIssue')
          }
        />
      );
    }
    case 'selfHealing': {
      return (
        <Alert
          showIcon
          action={ctx.restartAction}
          message={t('networkProxy.banners.selfHealing')}
          type="warning"
          description={
            <div style={stackStyle}>
              <span>{t('networkProxy.banners.selfHealingDesc', { seconds: state.seconds })}</span>
              <IssueDescription issue={state.issue} />
            </div>
          }
        />
      );
    }
    case 'fallback': {
      return (
        <Alert
          showIcon
          message={t('networkProxy.banners.fallback')}
          type="warning"
          description={t('networkProxy.banners.fallbackDesc', {
            scopes: state.scopes.join(', '),
          })}
        />
      );
    }
    case 'geodata': {
      return (
        <Alert
          showIcon
          description={t('networkProxy.banners.geodataDesc')}
          message={t('networkProxy.banners.geodata')}
          type="info"
          action={
            <Button
              disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.installGeodata)}
              loading={actions.isBusy(NETWORK_PROXY_FIELDS.installGeodata)}
              size="small"
              type="primary"
              onClick={ctx.onInstallGeodata}
            >
              {t('networkProxy.engine.geodata.install')}
            </Button>
          }
        />
      );
    }
  }
};

/**
 * Every failure state on this page, in one pass: the resolver names which states hold (and which
 * one of the two engine states wins), this component turns each name into its banner.
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
    geodataState,
    globalProxyActive,
    onInstallGeodata,
    onReloadArtifacts,
    onReloadStatus,
    status,
    statusError,
    statusStale,
  }) => {
    const { t } = useTranslation('admin');
    const instances = status?.instances ?? [];
    const groups = groupEngineInstances(instances);
    const { healing, terminal } = groups;
    const healingSeconds = useCountdown(healing[0] ? healingOf(healing[0])?.nextAttemptAt : null);
    const selfHealed = useSelfHealed(
      healing.map((instance) => instance.instanceId),
      instances
        .filter((instance) => LIVE_STATES.has(instance.engineState))
        .map((instance) => instance.instanceId),
      instances.map((instance) => instance.instanceId),
      terminal.length > 0,
    );

    const banners = resolveNetworkProxyBanners({
      artifacts,
      artifactsError,
      artifactsStale,
      config,
      conflictCount: actions.conflicts.length,
      fallbackScopes: status?.fallbackScopes ?? [],
      geodataState,
      globalProxyActive,
      groups,
      healingSeconds,
      selfHealed,
      status,
      statusError,
      statusStale,
    });

    const context: BannerRenderContext = {
      actions,
      canManage,
      onInstallGeodata,
      onReloadArtifacts,
      onReloadStatus,
      restartAction: (
        <Button
          disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
          loading={actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
          size="small"
          onClick={() => void actions.restartEngine()}
        >
          {t('networkProxy.engine.restart')}
        </Button>
      ),
      t,
    };

    return (
      <>
        {banners.map((state) => (
          <Fragment key={state.kind}>{renderBanner(state, context)}</Fragment>
        ))}
      </>
    );
  },
);

NetworkProxyBanners.displayName = 'NetworkProxyBanners';

export default NetworkProxyBanners;
