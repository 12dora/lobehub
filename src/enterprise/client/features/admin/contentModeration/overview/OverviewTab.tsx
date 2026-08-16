'use client';

import { Alert, Flexbox, Skeleton } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import TimeRangeFilter from '../../primitives/TimeRangeFilter';
import {
  invalidateModerationOverview,
  invalidateModerationRecords,
  useModerationOverview,
  useModerationStats,
} from '../hooks';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import KpiRow from './KpiRow';
import ModerationCharts from './ModerationCharts';
import StatusCards from './StatusCards';
import { resolveBrowserTimezone, useModerationTimeRange } from './useModerationTimeRange';

export interface OverviewTabProps {
  canManage: boolean;
  enabled: boolean;
  onOpenRecordsForUser: (userId: string) => void;
  onOpenSettings: () => void;
}

/**
 * 概况 tab (design §6.1): configuration state on top, then the measured behaviour of that
 * configuration over the selected window. Warnings sit above everything because a bypass or a
 * missing downgrade target invalidates how the numbers below should be read.
 */
const OverviewTab = memo<OverviewTabProps>(
  ({ canManage, enabled, onOpenRecordsForUser, onOpenSettings }) => {
    const { t } = useTranslation('admin');
    const { authMethod } = useAdminAccess();
    const timeRange = useModerationTimeRange();
    const [clearing, setClearing] = useState(false);

    const overview = useModerationOverview(enabled);
    const statsInput = useMemo(
      () => ({
        from: new Date(timeRange.range.startAt),
        timezone: resolveBrowserTimezone(),
        to: new Date(timeRange.range.endAt),
      }),
      [timeRange.range.endAt, timeRange.range.startAt],
    );
    const stats = useModerationStats(enabled, statsInput);

    const overviewLoading = overview.isLoading && !overview.data;
    const overviewFailed = Boolean(overview.error) && !overview.data;
    const statsLoading = stats.isLoading && !stats.data;
    const statsFailed = Boolean(stats.error) && !stats.data;

    const handleClearCache = () => {
      if (!canManage || clearing) return;
      openDangerConfirm({
        content: t('contentModeration.overview.clearCacheConfirm'),
        title: t('contentModeration.overview.clearCacheTitle'),
        onConfirm: async () => {
          setClearing(true);
          try {
            const ok = await runAdminMutation({
              authMethod,
              mapErrorKey: () => 'contentModeration.toast.clearCacheFailed',
              run: async () => {
                const result = await adminContentModerationService.clearDecisionCache();
                toast.success(
                  t('contentModeration.toast.clearCacheSuccess', { count: result.deleted }),
                );
              },
            });
            if (ok) await invalidateModerationOverview();
          } finally {
            setClearing(false);
          }
        },
      });
    };

    return (
      <Flexbox className={styles.stack} gap={16}>
        {(overview.data?.warnings ?? []).map((warning) => (
          <Alert
            showIcon
            description={t(`contentModeration.warning.${warning}.desc` as never)}
            key={warning}
            message={t(`contentModeration.warning.${warning}.title` as never)}
            type="warning"
            action={
              warning === 'client_fetch_bypass' ? undefined : (
                <Button size="small" onClick={onOpenSettings}>
                  {t('contentModeration.overview.openSettings')}
                </Button>
              )
            }
          />
        ))}

        {overviewLoading ? <Skeleton.Block height={160} width="100%" /> : null}

        {overviewFailed ? (
          <Alert
            showIcon
            message={t('contentModeration.overview.loadFailed')}
            type="error"
            action={
              <Button size="small" onClick={() => void overview.mutate()}>
                {t('contentModeration.charts.retry')}
              </Button>
            }
          />
        ) : null}

        {overview.data ? (
          <StatusCards
            canManage={canManage}
            clearing={clearing}
            data={overview.data}
            onClearCache={handleClearCache}
            onOpenSettings={onOpenSettings}
          />
        ) : null}

        <div className={styles.toolbarRow}>
          <TimeRangeFilter
            customFrom={timeRange.customFrom}
            customTo={timeRange.customTo}
            rangeKey={timeRange.rangeKey}
            setCustomRange={timeRange.setCustomRange}
            setRangeKey={timeRange.setRangeKey}
          />
        </div>

        <KpiRow kpi={stats.data?.kpi} loading={statsLoading} mode={overview.data?.mode} />

        <ModerationCharts
          data={stats.data}
          error={statsFailed}
          loading={statsLoading}
          onSelectUser={onOpenRecordsForUser}
          onRetry={() => {
            void stats.mutate();
            void invalidateModerationRecords();
          }}
        />
      </Flexbox>
    );
  },
);

OverviewTab.displayName = 'ModerationOverviewTab';

export default OverviewTab;
