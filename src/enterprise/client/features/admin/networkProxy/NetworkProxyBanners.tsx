'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArtifactStatusView,
  EngineIssue,
  InstanceStatusView,
  NetworkProxyConfigView,
  NetworkProxyStatusView,
} from '@/types/platform/networkProxy';

import { networkProxyIssueKey } from './errors';
import type { NetworkProxyGeodataState } from './geodataState';
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

/** How long the "it came back on its own" confirmation stays before it gets out of the way. */
const SELF_HEALED_VISIBLE_MS = 8000;

/**
 * A server that predates the engine-issue model answers without these fields; an admin panel that
 * crashed on that would be worse than one that says nothing.
 */
const issueOf = (instance: InstanceStatusView): EngineIssue | null => instance.lastIssue ?? null;

const healingOf = (instance: InstanceStatusView): InstanceStatusView['healing'] =>
  instance.healing ?? null;

/**
 * States that speak for themselves. `running` and `degraded` are live engines, and a `stopped`
 * engine is usually one an admin turned off — none of them is an outage just because the last
 * issue recorded before them is still on the row.
 */
const SELF_EXPLANATORY_STATES = new Set(['degraded', 'running', 'stopped']);

const hasEngineIssue = (instance: InstanceStatusView): boolean =>
  instance.engineState === 'error' ||
  (issueOf(instance) !== null && !SELF_EXPLANATORY_STATES.has(instance.engineState));

/** Whole seconds until `at`, ticking down once a second without touching the network. */
const useCountdown = (at: string | null | undefined): number => {
  const target = at ? Date.parse(at) : Number.NaN;
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setSeconds(0);
      return;
    }
    const compute = () => Math.max(0, Math.ceil((target - Date.now()) / 1000));
    setSeconds(compute());
    const timer = setInterval(() => setSeconds(compute()), 1000);
    return () => clearInterval(timer);
  }, [target]);

  return seconds;
};

/** Engine states that mean the process is up and serving, whatever it reported before. */
const LIVE_STATES = new Set(['degraded', 'running']);

/**
 * `true` for one moment after an engine the supervisor was *automatically* retrying comes back
 * up, so the admin who saw the recovery banner learns it worked instead of just finding it gone.
 *
 * Both halves are load-bearing. Without `healingObserved` this would congratulate itself on a
 * stop the admin asked for or a restart they performed by hand; without `recovered` it would fire
 * the moment the row leaves `error`, while the engine is still only `starting`.
 */
const useSelfHealed = (healingObserved: boolean, recovered: boolean): boolean => {
  const sawHealing = useRef(false);
  const [healedAt, setHealedAt] = useState<number | null>(null);

  useEffect(() => {
    if (healingObserved) {
      sawHealing.current = true;
      setHealedAt(null);
      return;
    }
    if (sawHealing.current && recovered) {
      sawHealing.current = false;
      setHealedAt(Date.now());
    }
  }, [healingObserved, recovered]);

  useEffect(() => {
    if (healedAt === null) return;
    const timer = setTimeout(() => setHealedAt(null), SELF_HEALED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [healedAt]);

  return healedAt !== null;
};

/** The engine's own reason, plus its technical detail folded away behind a toggle. */
const IssueDescription = memo<{ issue: EngineIssue | null }>(({ issue }) => {
  const { t } = useTranslation('admin');
  const [detailOpen, setDetailOpen] = useState(false);
  const detail = issue?.detail ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span>{t(networkProxyIssueKey(issue?.code) as never)}</span>
      {detail ? (
        <div className={styles.inlineActions}>
          <Button size="small" onClick={() => setDetailOpen((open) => !open)}>
            {t('networkProxy.engineIssue.detailToggle')}
          </Button>
          {detailOpen ? <span className={styles.code}>{detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
});
IssueDescription.displayName = 'NetworkProxyIssueDescription';

/**
 * Every failure state on this page, stated as "what is happening / what to do" (DESIGN.md,
 * 确定性). Ordered by how much of the platform each one affects.
 *
 * A failed *query* is reported as unknown state with a Retry — never as a healthy-looking
 * "not installed / no nodes", which would send an admin chasing an outage that is not there.
 *
 * The engine gets exactly one banner: an instance id means nothing to the person reading it, and
 * two banners about one engine read as two outages. While the supervisor is retrying by itself,
 * that banner says so — with the countdown — instead of demanding an action nobody needs to take.
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
    const troubled = instances.filter(hasEngineIssue);
    // Missing rule data is a setup step, not a breakage — it gets the install banner below.
    const geodataMissing = troubled.some(
      (instance) => issueOf(instance)?.code === 'geodata_missing',
    );
    const actionable = troubled.filter((instance) => issueOf(instance)?.code !== 'geodata_missing');
    // Automatic recovery only exists on an instance the supervisor has given up starting; every
    // other broken instance is terminal and still needs a human. One recovering instance must
    // never hide the ones that are not — they are different problems on different machines.
    const healing = actionable.filter(
      (instance) => instance.engineState === 'error' && healingOf(instance) !== null,
    );
    const terminal = actionable.filter((instance) => !healing.includes(instance));
    const healingSeconds = useCountdown(healing[0] ? healingOf(healing[0])?.nextAttemptAt : null);
    const selfHealed = useSelfHealed(
      healing.length > 0,
      terminal.length === 0 && instances.some((instance) => LIVE_STATES.has(instance.engineState)),
    );
    const fallbackScopes = status?.fallbackScopes ?? [];
    const conflictCount = actions.conflicts.length;
    const restartAction = (
      <Button
        disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
        loading={actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
        size="small"
        onClick={() => void actions.restartEngine()}
      >
        {t('networkProxy.engine.restart')}
      </Button>
    );

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

        {selfHealed ? (
          <Alert showIcon message={t('networkProxy.banners.selfHealed')} type="success" />
        ) : null}

        {terminal.length > 0 ? (
          <Alert
            showIcon
            action={restartAction}
            type="error"
            description={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <IssueDescription issue={terminal[0] ? issueOf(terminal[0]) : null} />
                {/* The recovering instances are real, but they are not what this banner is
                    asking the admin to act on. */}
                {healing.length > 0 ? (
                  <span>
                    {t('networkProxy.banners.selfHealingAlso', { count: healing.length })}
                  </span>
                ) : null}
              </div>
            }
            message={
              terminal.length > 1
                ? t('networkProxy.banners.engineIssueMulti', { count: terminal.length })
                : t('networkProxy.banners.engineIssue')
            }
          />
        ) : healing.length > 0 ? (
          <Alert
            showIcon
            action={restartAction}
            message={t('networkProxy.banners.selfHealing')}
            type="warning"
            description={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <span>
                  {t('networkProxy.banners.selfHealingDesc', { seconds: healingSeconds })}
                </span>
                <IssueDescription issue={healing[0] ? issueOf(healing[0]) : null} />
              </div>
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

        {/* Only claim geodata is missing when we actually know what is installed — an
            unreachable status query is not evidence of an empty disk. */}
        {(geodataMissing || (config.ruleMode === 'smart' && geodataState === 'missing')) &&
        !(artifactsError && !artifacts) ? (
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
                onClick={onInstallGeodata}
              >
                {t('networkProxy.engine.geodata.install')}
              </Button>
            }
          />
        ) : null}
      </>
    );
  },
);

NetworkProxyBanners.displayName = 'NetworkProxyBanners';

export default NetworkProxyBanners;
