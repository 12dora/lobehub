'use client';

import { Icon, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { OperationalStatus } from '@/enterprise/client/features/admin/system/components/OperationalStatus';
import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderJob,
  AdminSystemDocumentRenderStatus,
} from '@/enterprise/client/services/adminSystem';

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
      </div>
    );
  },
);

DocumentRenderStatusPanel.displayName = 'AdminDocumentRenderStatusPanel';
