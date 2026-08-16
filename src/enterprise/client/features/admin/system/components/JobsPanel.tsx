'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemJobAction } from '@/enterprise/client/features/admin/system/controller';
import { canRunAdminSystemJobAction } from '@/enterprise/client/features/admin/system/controller';
import type {
  AdminSystemJobMutations,
  AdminSystemJobsState,
} from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { openJobActionModal } from '@/enterprise/client/features/admin/system/modals/openJobActionModal';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemJob } from '@/enterprise/client/services/adminSystem';

import { OperationalStatus } from './OperationalStatus';

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  footer: css`
    display: flex;
    justify-content: center;
    padding-block: 8px;
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

export interface JobsPanelProps {
  canOperate: boolean;
  mutations: AdminSystemJobMutations;
  state: AdminSystemJobsState;
}

export const JobsPanel = memo<JobsPanelProps>(({ canOperate, mutations, state }) => {
  const { t } = useTranslation('admin');
  const blocked = useMemo(
    () => new Set([...mutations.busyJobIds, ...mutations.refreshPendingJobIds]),
    [mutations.busyJobIds, mutations.refreshPendingJobIds],
  );

  const openAction = useCallback(
    (job: AdminSystemJob, action: AdminSystemJobAction) => {
      if (blocked.has(job.jobId) || !canRunAdminSystemJobAction(job, action)) return;
      openJobActionModal({
        action,
        jobId: job.jobId,
        onSubmit: async (reason) => {
          const result =
            action === 'cancel'
              ? await mutations.cancel(job, reason)
              : await mutations.retry(job, reason);
          if (result === 'succeeded') {
            toast.success(t(`system.jobs.toast.${action}Requested` as never));
          } else if (result === 'conflict') {
            toast.error(t('system.jobs.toast.conflict'));
          } else if (result === 'refresh_failed') {
            toast.error(t('system.jobs.toast.committedRefreshFailed'));
          } else {
            toast.error(t(`system.jobs.toast.${action}Failed` as never));
          }
        },
      });
    },
    [blocked, mutations, t],
  );

  const columns = useMemo<TableColumnsType<AdminSystemJob>>(
    () => [
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
                const pending = mutations.busyJobIds.includes(job.jobId);
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
    ],
    [blocked, canOperate, mutations.busyJobIds, openAction, t],
  );

  return (
    <Flexbox gap={8}>
      {!canOperate ? <Alert showIcon message={t('system.jobs.readOnly')} type="info" /> : null}
      {state.hasStagedUpdate ? (
        <Alert
          showIcon
          description={t('system.jobs.updatesAvailableDescription')}
          message={t('system.jobs.updatesAvailable')}
          type="info"
          action={
            <Button
              disabled={mutations.busyJobIds.length > 0}
              size="small"
              onClick={() => void state.applyStagedUpdate()}
            >
              {t('system.jobs.actions.applyUpdates')}
            </Button>
          }
        />
      ) : null}
      {mutations.refreshPendingJobIds.length > 0 ? (
        <Alert
          showIcon
          message={t('system.jobs.committedRefreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void mutations.retryRefresh()}>
              {t('system.actions.retry')}
            </Button>
          }
        />
      ) : null}
      {state.pollError ? (
        <Alert showIcon message={t('system.jobs.pollFailed')} type="warning" />
      ) : null}
      {state.backgroundError && state.jobs.length > 0 ? (
        <Alert
          showIcon
          message={t('system.jobs.refreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void state.refresh()}>
              {t('system.actions.retry')}
            </Button>
          }
        />
      ) : null}
      <DataTable<AdminSystemJob>
        columns={columns}
        dataSource={state.jobs}
        emptyDescription={t('system.jobs.empty')}
        error={Boolean(state.initialError)}
        loading={state.isLoadingInitial}
        pagination={false}
        rowKey="jobId"
        scroll={{ x: canOperate ? 1100 : 930 }}
        size="small"
        onRetry={() => void state.refresh()}
      />
      {state.loadMoreError ? (
        <Alert
          showIcon
          message={t('system.jobs.loadMoreFailed')}
          type="error"
          action={
            <Button size="small" onClick={state.retryLoadMore}>
              {t('system.actions.retry')}
            </Button>
          }
        />
      ) : state.hasMore ? (
        <div className={styles.footer}>
          <Button
            disabled={state.isLoadingMore}
            loading={state.isLoadingMore}
            onClick={state.loadMore}
          >
            {t('system.jobs.actions.loadMore')}
          </Button>
        </div>
      ) : state.jobs.length > 0 ? (
        <div className={styles.footer}>
          <Text type="secondary">{t('system.jobs.end')}</Text>
        </div>
      ) : null}
    </Flexbox>
  );
});

JobsPanel.displayName = 'AdminSystemJobsPanel';
