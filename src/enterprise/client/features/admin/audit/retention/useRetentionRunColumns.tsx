import { Flexbox, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Progress, type TableColumnsType } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditRetentionRunItem } from '@/enterprise/client/services/adminAudit';

import AuditStatusTag from '../shared/AuditStatusTag';
import { formatAdminDateTime } from '../shared/format';
import { totalDeleted } from './policyBounds';

export const useRetentionRunColumns = ({
  onCancelRun,
}: {
  onCancelRun: (row: AdminAuditRetentionRunItem) => void;
}): TableColumnsType<AdminAuditRetentionRunItem> => {
  const { t } = useTranslation('admin');

  return useMemo(
    () => [
      {
        dataIndex: 'mode',
        key: 'mode',
        title: t('audit.retention.runs.mode'),
        width: 110,
        render: (v: string) => <AuditStatusTag kind="mode" value={v} />,
      },
      {
        dataIndex: 'scope',
        key: 'scope',
        title: t('audit.retention.runs.scope'),
        width: 140,
        render: (v: string) => t(`audit.retention.scope.${v}` as never, { defaultValue: v }),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.retention.runs.status'),
        width: 110,
        render: (v: string) => <AuditStatusTag kind="retention" value={v} />,
      },
      {
        key: 'progress',
        title: t('audit.retention.runs.progress'),
        width: 160,
        render: (_, row) => {
          if (row.status !== 'running' && row.status !== 'pending') {
            return `${row.progressDone}${row.progressTotal != null ? ` / ${row.progressTotal}` : ''}`;
          }
          const pct =
            row.progressTotal && row.progressTotal > 0
              ? Math.round((row.progressDone / row.progressTotal) * 100)
              : 0;
          return <Progress percent={pct} size="small" />;
        },
      },
      {
        dataIndex: 'cutoffAt',
        key: 'cutoffAt',
        title: t('audit.retention.runs.cutoff'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        key: 'counts',
        title: t('audit.retention.runs.counts'),
        render: (_, row) => (
          <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
            <span>
              {t('audit.retention.runs.deleted')}: {totalDeleted(row.counts)}
            </span>
            {(row.counts.skippedLegalHold ?? 0) > 0 ? (
              <Tag color="warning" size="small">
                {t('audit.retention.runs.skippedHold', { count: row.counts.skippedLegalHold })}
              </Tag>
            ) : null}
          </Flexbox>
        ),
      },
      {
        dataIndex: 'requestedBy',
        key: 'requestedBy',
        title: t('audit.retention.runs.requestedBy'),
        width: 120,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('audit.retention.runs.createdAt'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        key: 'actions',
        title: t('audit.retention.runs.actions'),
        width: 100,
        render: (_, row) =>
          row.status === 'pending' || row.status === 'running' ? (
            <Button danger size="small" onClick={() => onCancelRun(row)}>
              {t('audit.retention.runs.cancel')}
            </Button>
          ) : null,
      },
    ],
    [onCancelRun, t],
  );
};
