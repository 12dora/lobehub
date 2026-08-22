'use client';

import { Icon, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { OperationalStatus } from '@/enterprise/client/features/admin/system/components/OperationalStatus';
import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderJob,
  AdminSystemDocumentRenderStatus,
} from '@/enterprise/client/services/adminSystem';

import {
  EM_DASH,
  formatAbsolute,
  formatArtifactBytes,
  formatCount,
  relativeLabel,
} from './documentRenderMaintenanceFormat';

const styles = createStaticStyles(({ css }) => ({
  cell: css`
    padding-block: 6px;
    padding-inline: 0;

    font-size: ${cssVar.fontSizeSM};
    text-align: start;
    vertical-align: middle;
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  headCell: css`
    padding-block: 4px;
    padding-inline: 0;

    font-size: ${cssVar.fontSizeSM};
    font-weight: ${cssVar.fontWeightStrong};
    color: ${cssVar.colorTextSecondary};
    text-align: start;
  `,
  metricGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 8px 12px;
  `,
  metricLabel: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  metricValue: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSize};
    font-variant-numeric: tabular-nums;
  `,
  row: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /* A queue table on a half-width card: never let it push the page sideways. */
  scroller: css`
    overflow-x: auto;
    min-width: 0;
  `,
  /* Sits above the read-only rows, so the rule belongs under it rather than over it. */
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 0;
    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  sidecarRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  /* Maintenance / feed live under the queue: a hairline keeps the three readings apart. */
  subSection: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 0;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  subSectionHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  table: css`
    border-collapse: collapse;
    width: 100%;
  `,
}));

const SIDECAR_PRESENTATION: Record<
  AdminSystemDocumentRenderStatus['sidecar']['status'],
  { icon: LucideIcon; tone: 'default' | 'error' | 'success' | 'warning' }
> = {
  disabled: { icon: CircleDashed, tone: 'default' },
  down: { icon: XCircle, tone: 'error' },
  unconfigured: { icon: AlertTriangle, tone: 'warning' },
  up: { icon: CheckCircle2, tone: 'success' },
};

/** Terminal jobs can be retried; anything still queued or in flight can be cancelled. */
const isRetryable = (status: string): boolean => status === 'failed' || status === 'dead';
const isCancellable = (status: string): boolean =>
  status === 'pending' || status === 'running' || status === 'reserved';

export interface DocumentRenderStatusPanelProps {
  canOperate: boolean;
  onRefresh: () => Promise<unknown> | void;
  service: AdminDocumentRenderSettingsService;
  status: AdminSystemDocumentRenderStatus;
}

const QUEUE_METRICS = ['pending', 'running', 'failed24h', 'succeeded24h'] as const;

const JobRow = memo<{
  busy: boolean;
  canOperate: boolean;
  job: AdminSystemDocumentRenderJob;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}>(({ busy, canOperate, job, onCancel, onRetry }) => {
  const { t } = useTranslation('admin');
  const retry = canOperate && isRetryable(job.status);
  const cancel = canOperate && isCancellable(job.status);

  return (
    <tr className={styles.row}>
      <td className={`${styles.cell} ${styles.code}`}>
        {job.fileId.slice(0, 8)}
        {job.ext ? `.${job.ext}` : ''}
      </td>
      <td className={styles.cell}>
        <OperationalStatus status={job.status} />
      </td>
      <td className={`${styles.cell} ${styles.code}`}>{job.pages ?? '—'}</td>
      <td className={`${styles.cell} ${styles.code}`}>
        {job.durationMs === null ? '—' : t('systemGeneral.test.latency', { ms: job.durationMs })}
      </td>
      <td className={styles.cell}>
        {retry || cancel ? (
          <>
            {retry ? (
              <Button disabled={busy} size="small" onClick={() => onRetry(job.id)}>
                {t('systemGeneral.documentRender.actions.retry')}
              </Button>
            ) : null}
            {cancel ? (
              <Button disabled={busy} size="small" onClick={() => onCancel(job.id)}>
                {t('systemGeneral.documentRender.actions.cancel')}
              </Button>
            ) : null}
          </>
        ) : (
          <Text type="secondary">—</Text>
        )}
      </td>
    </tr>
  );
});

JobRow.displayName = 'AdminDocumentRenderJobRow';

/** One label + value pair; the value is already a string or a node the caller composed. */
const Metric = memo<{ children: ReactNode; label: string }>(({ children, label }) => (
  <div>
    <div className={styles.metricLabel}>{label}</div>
    <div className={styles.metricValue}>{children}</div>
  </div>
));

Metric.displayName = 'AdminDocumentRenderMetric';

/** The feed counters, in the order that tells the story: how much went out, then what degraded. */
const FEED_METRICS = [
  'requestsWithImages',
  'docsFed',
  'imagesFed',
  'pendingWaits',
  'pendingFallbacks',
  'toolPageViews',
] as const;

const FeedBlock = memo<{ feed: AdminSystemDocumentRenderStatus['feed'] }>(({ feed }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.subSection}>
      <div className={styles.subSectionHeader}>
        <Text strong>{t('systemGeneral.documentRender.feed.title')}</Text>
        <Text type="secondary">
          {t('systemGeneral.documentRender.feed.since', { since: formatAbsolute(feed.since) })}
        </Text>
      </div>
      <div className={styles.metricGrid}>
        {FEED_METRICS.map((metric) => (
          <Metric key={metric} label={t(`systemGeneral.documentRender.feed.${metric}` as never)}>
            {formatCount(feed[metric])}
          </Metric>
        ))}
      </div>
    </div>
  );
});

FeedBlock.displayName = 'AdminDocumentRenderFeedBlock';

/** A finished sweep can take a moment to land; poll a bounded number of times, then stop. */
const GC_POLL_INTERVAL_MS = 5000;
const GC_POLL_ATTEMPTS = 6;

const MaintenanceBlock = memo<{
  canOperate: boolean;
  maintenance: AdminSystemDocumentRenderStatus['maintenance'];
  onRefresh: () => Promise<unknown> | void;
  service: AdminDocumentRenderSettingsService;
}>(({ canOperate, maintenance, onRefresh, service }) => {
  const { t } = useTranslation('admin');
  const [running, setRunning] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    },
    [],
  );

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      await service.runDocumentRenderGc({});
      toast.success(t('systemGeneral.documentRender.maintenance.queued'));
      await onRefresh();
      for (let attempt = 1; attempt <= GC_POLL_ATTEMPTS; attempt += 1) {
        timers.current.push(setTimeout(() => void onRefresh(), attempt * GC_POLL_INTERVAL_MS));
      }
    } catch {
      toast.error(t('systemGeneral.documentRender.maintenance.failed'));
    } finally {
      setRunning(false);
    }
  }, [onRefresh, running, service, t]);

  const confirm = useCallback(() => {
    confirmModal({
      cancelText: t('systemGeneral.documentRender.maintenance.confirmCancel'),
      content: t('systemGeneral.documentRender.maintenance.confirmContent'),
      okText: t('systemGeneral.documentRender.maintenance.confirmOk'),
      title: t('systemGeneral.documentRender.maintenance.confirmTitle'),
      onOk: async () => {
        await run();
      },
    });
  }, [run, t]);

  const relative = relativeLabel(maintenance.lastRunAt);

  return (
    <div className={styles.subSection}>
      <div className={styles.subSectionHeader}>
        <Text strong>{t('systemGeneral.documentRender.maintenance.title')}</Text>
        {canOperate ? (
          <Button disabled={running} loading={running} size="small" onClick={confirm}>
            {t('systemGeneral.documentRender.maintenance.run')}
          </Button>
        ) : null}
      </div>

      <div className={styles.metricGrid}>
        <Metric label={t('systemGeneral.documentRender.maintenance.lastRun')}>
          {relative ? (
            <Tooltip title={formatAbsolute(maintenance.lastRunAt)}>
              <span>
                {t(
                  `systemGeneral.documentRender.maintenance.relative.${relative.key}` as never,
                  relative.count === undefined ? undefined : { count: relative.count },
                )}
              </span>
            </Tooltip>
          ) : (
            EM_DASH
          )}
        </Metric>
        <Metric label={t('systemGeneral.documentRender.maintenance.jobStatus')}>
          {maintenance.jobStatus ? (
            <OperationalStatus status={maintenance.jobStatus} />
          ) : (
            <Text type="secondary">{t('systemGeneral.documentRender.maintenance.never')}</Text>
          )}
        </Metric>
        <Metric label={t('systemGeneral.documentRender.maintenance.artifacts')}>
          {`${formatCount(maintenance.artifactObjects)} · ${formatArtifactBytes(maintenance.artifactBytes)}`}
        </Metric>
        <Metric label={t('systemGeneral.documentRender.maintenance.orphans')}>
          {`${formatCount(maintenance.orphanObjects)} · ${formatArtifactBytes(maintenance.orphanBytes)}`}
        </Metric>
        <Metric label={t('systemGeneral.documentRender.maintenance.expiredFiles')}>
          {formatCount(maintenance.expiredFiles)}
        </Metric>
        <Metric label={t('systemGeneral.documentRender.maintenance.tempDir')}>
          {formatArtifactBytes(maintenance.tempDirBytes)}
        </Metric>
      </div>

      {maintenance.lastError ? (
        <Tooltip title={maintenance.lastError}>
          <Text ellipsis type="danger">
            {t('systemGeneral.documentRender.maintenance.lastError', {
              message: maintenance.lastError,
            })}
          </Text>
        </Tooltip>
      ) : null}
    </div>
  );
});

MaintenanceBlock.displayName = 'AdminDocumentRenderMaintenanceBlock';

/**
 * The compact monitoring summary that lives inside the settings card (design §6.3).
 *
 * It answers the two questions an operator has right after saving an endpoint — "is the sidecar
 * there?" and "is anything stuck?" — without making them open the status page, and offers the two
 * actions that unstick a queue.
 */
export const DocumentRenderStatusPanel = memo<DocumentRenderStatusPanelProps>(
  ({ canOperate, onRefresh, service, status }) => {
    const { t } = useTranslation('admin');
    const [busyJobId, setBusyJobId] = useState<string | null>(null);
    const sidecar = SIDECAR_PRESENTATION[status.sidecar.status];

    const act = useCallback(
      async (jobId: string, kind: 'cancel' | 'retry') => {
        if (busyJobId) return;
        setBusyJobId(jobId);
        try {
          await (kind === 'retry'
            ? service.retryDocumentRenderJob({ jobId })
            : service.cancelDocumentRenderJob({ jobId }));
          toast.success(t(`systemGeneral.documentRender.actions.${kind}Done` as never));
          await onRefresh();
        } catch {
          toast.error(t(`systemGeneral.documentRender.actions.${kind}Failed` as never));
        } finally {
          setBusyJobId(null);
        }
      },
      [busyJobId, onRefresh, service, t],
    );

    const onRetry = useCallback((jobId: string) => void act(jobId, 'retry'), [act]);
    const onCancel = useCallback((jobId: string) => void act(jobId, 'cancel'), [act]);

    return (
      <div className={styles.section}>
        <div className={styles.sidecarRow}>
          <Text type="secondary">{t('systemGeneral.documentRender.status.sidecar')}</Text>
          <Tag color={sidecar.tone} icon={<Icon icon={sidecar.icon} size={12} />} size="small">
            {t(`systemGeneral.documentRender.status.${status.sidecar.status}` as never)}
          </Tag>
          {status.sidecar.version ? (
            <Text className={styles.code} type="secondary">
              {t('systemGeneral.documentRender.status.version', {
                version: status.sidecar.version,
              })}
            </Text>
          ) : null}
          {typeof status.sidecar.latencyMs === 'number' ? (
            <Text className={styles.code} type="secondary">
              {t('systemGeneral.test.latency', { ms: status.sidecar.latencyMs })}
            </Text>
          ) : null}
        </div>
        {status.sidecar.error ? <Text type="danger">{status.sidecar.error}</Text> : null}

        <div className={styles.metricGrid}>
          {QUEUE_METRICS.map((metric) => (
            <div key={metric}>
              <div className={styles.metricLabel}>
                {t(`systemGeneral.documentRender.queue.${metric}` as never)}
              </div>
              <div className={styles.metricValue}>{status.queue[metric]}</div>
            </div>
          ))}
          <div>
            <div className={styles.metricLabel}>
              {t('systemGeneral.documentRender.queue.avgMs')}
            </div>
            <div className={styles.metricValue}>
              {status.queue.avgMs === null ? '—' : Math.round(status.queue.avgMs)}
            </div>
          </div>
          <div>
            <div className={styles.metricLabel}>
              {t('systemGeneral.documentRender.queue.p95Ms')}
            </div>
            <div className={styles.metricValue}>
              {status.queue.p95Ms === null ? '—' : Math.round(status.queue.p95Ms)}
            </div>
          </div>
        </div>

        {status.queue.recent.length === 0 ? (
          <Text type="secondary">{t('systemGeneral.documentRender.queue.empty')}</Text>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.headCell} scope="col">
                    {t('systemGeneral.documentRender.queue.columns.file')}
                  </th>
                  <th className={styles.headCell} scope="col">
                    {t('systemGeneral.documentRender.queue.columns.status')}
                  </th>
                  <th className={styles.headCell} scope="col">
                    {t('systemGeneral.documentRender.queue.columns.pages')}
                  </th>
                  <th className={styles.headCell} scope="col">
                    {t('systemGeneral.documentRender.queue.columns.duration')}
                  </th>
                  <th className={styles.headCell} scope="col">
                    {t('systemGeneral.documentRender.queue.columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {status.queue.recent.map((job) => (
                  <JobRow
                    busy={busyJobId !== null}
                    canOperate={canOperate}
                    job={job}
                    key={job.id}
                    onCancel={onCancel}
                    onRetry={onRetry}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <MaintenanceBlock
          canOperate={canOperate && status.moduleEnabled}
          maintenance={status.maintenance}
          service={service}
          onRefresh={onRefresh}
        />
        <FeedBlock feed={status.feed} />
      </div>
    );
  },
);

DocumentRenderStatusPanel.displayName = 'AdminDocumentRenderStatusPanel';
