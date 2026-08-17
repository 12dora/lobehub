'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { openDangerConfirm } from '@/enterprise/client/features/admin/primitives/DangerConfirm';
import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import type { AdminSystemJobAction } from '@/enterprise/client/features/admin/system/controller';
import { canRunAdminSystemJobAction } from '@/enterprise/client/features/admin/system/controller';
import type {
  AdminSystemJobMutations,
  AdminSystemJobsState,
} from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import type { AdminSystemJob } from '@/enterprise/client/services/adminSystem';

import { buildJobsColumns } from './jobsColumns';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    display: flex;
    justify-content: center;
    padding-block: 8px;
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
      // Job control is operational, not destructive: confirm intent, never ask for a reason.
      openDangerConfirm({
        confirmText: t(`system.jobs.actions.${action}` as never),
        title: t(`system.jobs.modal.${action}.title` as never),
        content:
          action === 'cancel'
            ? `${t('system.jobs.modal.cancel.description', { jobId: job.jobId })} ${t(
                'system.jobs.modal.cancel.completedItems',
              )}`
            : t('system.jobs.modal.retry.description', { jobId: job.jobId }),
        onConfirm: async () => {
          const result =
            action === 'cancel' ? await mutations.cancel(job) : await mutations.retry(job);
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

  const columns = useMemo(
    () =>
      buildJobsColumns({
        blocked,
        busyJobIds: mutations.busyJobIds,
        canOperate,
        openAction,
        t,
      }),
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
