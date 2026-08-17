'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';

import {
  type AdminSystemJobAction,
  canRunAdminSystemJobAction,
} from '@/enterprise/client/features/admin/system/controller';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemJob } from '@/enterprise/client/services/adminSystem';

import { OperationalStatus } from './OperationalStatus';

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  progress: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
  `,
  typeId: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    overflow-wrap: anywhere;
  `,
}));

export interface BuildJobsColumnsParams {
  blocked: Set<string>;
  busyJobIds: readonly string[];
  canOperate: boolean;
  openAction: (job: AdminSystemJob, action: AdminSystemJobAction) => void;
  t: TFunction<'admin'>;
}

export const buildJobsColumns = ({
  blocked,
  busyJobIds,
  canOperate,
  openAction,
  t,
}: BuildJobsColumnsParams): TableColumnsType<AdminSystemJob> => [
  {
    key: 'kind',
    // The raw queue name stays visible so a job type that outran the label table is still
    // self-explanatory to an operator.
    render: (_, job) => (
      <Flexbox gap={2}>
        <Text>{t(`system.values.jobKind.${job.kind}` as never)}</Text>
        {job.typeId ? (
          <Text className={styles.typeId} type="secondary">
            {job.typeId}
          </Text>
        ) : null}
      </Flexbox>
    ),
    title: t('system.jobs.columns.job'),
    width: 220,
  },
  {
    dataIndex: 'status',
    key: 'status',
    render: (status: AdminSystemJob['status']) => <OperationalStatus status={status} />,
    title: t('system.jobs.columns.status'),
    width: 120,
  },
  {
    key: 'progress',
    render: (_, job) => (
      <Flexbox gap={4}>
        <Text className={styles.progress}>
          {job.progress.total === null
            ? t('system.jobs.progressUnknown', { done: job.progress.done })
            : t('system.jobs.progress', {
                done: job.progress.done,
                total: job.progress.total,
              })}
        </Text>
        {job.failedCount !== null && job.failedCount > 0 ? (
          <Text type="danger">{t('system.jobs.failedCount', { count: job.failedCount })}</Text>
        ) : null}
      </Flexbox>
    ),
    title: t('system.jobs.columns.progress'),
    width: 180,
  },
  {
    key: 'attempt',
    render: (_, job) => (
      <Text className={styles.code}>
        {job.maxAttempts === null
          ? String(job.attempt)
          : t('system.jobs.attempt', { attempt: job.attempt, max: job.maxAttempts })}
      </Text>
    ),
    title: t('system.jobs.columns.attempt'),
    width: 100,
  },
  {
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    render: (value: Date) => <Text className={styles.code}>{formatAdminDateTime(value)}</Text>,
    title: t('system.jobs.columns.updatedAt'),
    width: 180,
  },
  ...(canOperate
    ? [
        {
          fixed: 'right' as const,
          key: 'actions',
          render: (_: unknown, job: AdminSystemJob) => {
            const pending = busyJobIds.includes(job.jobId);
            const disabled = blocked.has(job.jobId);
            return (
              <Flexbox horizontal gap={8} justify="flex-end">
                {canRunAdminSystemJobAction(job, 'retry') ? (
                  <Button
                    disabled={disabled}
                    loading={pending}
                    size="small"
                    type="default"
                    onClick={() => openAction(job, 'retry')}
                  >
                    {t('system.jobs.actions.retry')}
                  </Button>
                ) : null}
                {canRunAdminSystemJobAction(job, 'cancel') ? (
                  <Button
                    danger
                    disabled={disabled}
                    loading={pending}
                    size="small"
                    type="default"
                    onClick={() => openAction(job, 'cancel')}
                  >
                    {t('system.jobs.actions.cancel')}
                  </Button>
                ) : null}
              </Flexbox>
            );
          },
          title: t('system.jobs.columns.actions'),
          width: 170,
        },
      ]
    : []),
];
