'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminLoadingSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';
import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import type {
  AdminSystemInstancesState,
  AdminSystemJobMutations,
  AdminSystemJobsState,
} from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import type { AdminSystemStatus } from '@/enterprise/client/services/adminSystem';

import { InstancesTable } from './components/InstancesTable';
import { JobsPanel } from './components/JobsPanel';
import {
  BuildSummary,
  DependencyGrid,
  JobsSummary,
  OidcSummary,
  PublishFailures,
} from './components/SystemOverview';

const styles = createStaticStyles(({ css }) => ({
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: ${cssVar.fontWeightStrong};
  `,
}));

interface AsyncSnapshot<T> {
  data?: T;
  error: unknown;
  isLoading: boolean;
}

export interface SystemPageViewProps {
  canOperate: boolean;
  instances: AdminSystemInstancesState;
  isRefreshing: boolean;
  jobs: AdminSystemJobsState;
  mutations: AdminSystemJobMutations;
  onRefresh: () => void;
  onShowOfflineInstancesChange: (showOffline: boolean) => void;
  showOfflineInstances: boolean;
  status: AsyncSnapshot<AdminSystemStatus> & { retry: () => void };
}

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <Text as="h2" className={styles.sectionTitle}>
    {children}
  </Text>
);

export const SystemPageView = memo<SystemPageViewProps>(
  ({
    canOperate,
    instances,
    isRefreshing,
    jobs,
    mutations,
    onRefresh,
    onShowOfflineInstancesChange,
    showOfflineInstances,
    status,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <AdminPageTemplate
        description={t('system.description')}
        title={t('system.title')}
        actions={
          <Button loading={isRefreshing} type="primary" onClick={onRefresh}>
            {t('system.actions.refresh')}
          </Button>
        }
      >
        {status.error && status.data ? (
          <Alert
            showIcon
            message={t('system.status.refreshFailed')}
            type="warning"
            action={
              <Button size="small" onClick={status.retry}>
                {t('system.actions.retry')}
              </Button>
            }
          />
        ) : null}

        {status.error && !status.data ? (
          <Alert
            showIcon
            description={t('system.status.loadFailedDescription')}
            message={t('system.status.loadFailed')}
            type="error"
            action={
              <Button size="small" type="primary" onClick={status.retry}>
                {t('system.actions.retry')}
              </Button>
            }
          />
        ) : status.isLoading && !status.data ? (
          <AdminLoadingSurface />
        ) : status.data ? (
          <Flexbox gap={20}>
            <BuildSummary status={status.data} />
            <DependencyGrid status={status.data} />
            <OidcSummary status={status.data} />
            <JobsSummary status={status.data} />
            <PublishFailures status={status.data} />
          </Flexbox>
        ) : null}

        <div className={styles.section}>
          <SectionTitle>{t('system.instances.title')}</SectionTitle>
          <Text type="secondary">{t('system.instances.description')}</Text>
          <InstancesTable
            showOffline={showOfflineInstances}
            state={instances}
            onShowOfflineChange={onShowOfflineInstancesChange}
          />
        </div>

        <div className={styles.section}>
          <SectionTitle>{t('system.jobs.title')}</SectionTitle>
          <Text type="secondary">{t('system.jobs.description')}</Text>
          <JobsPanel canOperate={canOperate} mutations={mutations} state={jobs} />
        </div>
      </AdminPageTemplate>
    );
  },
);

SystemPageView.displayName = 'AdminSystemPageView';
