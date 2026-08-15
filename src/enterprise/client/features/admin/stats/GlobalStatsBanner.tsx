'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { adminStatsService } from '@/enterprise/client/services/adminStats';
import { useClientDataSWR } from '@/libs/swr';
import { formatIntergerNumber } from '@/utils/format';

import type { AdminTimeRange } from '../primitives/timeRange.utils';
import { adminGlobalStatsDataSource } from './adminStatsDataSource';

const styles = createStaticStyles(({ css }) => ({
  banner: css`
    display: flex;
    flex-wrap: wrap;
    gap: 16px 24px;
    align-items: baseline;

    padding-block: 4px;
  `,
  metric: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  metricLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  metricValue: css`
    font-size: 18px;
    font-weight: 600;
  `,
}));

export interface GlobalStatsBannerProps {
  /** Active window; the active-user figure follows it. */
  range?: AdminTimeRange;
  /** The single user the page is pinned to, when any — part of the request, not decoration. */
  userId?: string;
  /** Display name of the single user the page is pinned to, when any. */
  userName?: string;
}

export const GlobalStatsBanner = memo<GlobalStatsBannerProps>(({ range, userId, userName }) => {
  const { t } = useTranslation('admin');
  const { data, error, isLoading, mutate } = useClientDataSWR(
    [
      'admin-stats:totals',
      adminGlobalStatsDataSource.scopeKey,
      range?.startAt,
      range?.endAt,
      userId ?? null,
    ],
    // Banner only needs user totals — avoid unused lifetime message/topic/agent scans.
    // The pinned user travels with the request and the cache key: the banner claims the
    // page is scoped to that user, so its own figures must be asked for under that scope.
    () =>
      adminStatsService.userTotals(range ? undefined : 30, {
        endAt: range?.endAt,
        startAt: range?.startAt,
        userId,
      }),
  );

  if (error && !data) {
    return (
      <Alert
        showIcon
        message={t('stats.banner.error')}
        type="error"
        action={
          <Button size="small" onClick={() => void mutate()}>
            {t('stats.banner.retry')}
          </Button>
        }
      />
    );
  }

  if (isLoading && !data) {
    return (
      <Flexbox horizontal className={styles.banner}>
        <Skeleton.Button active size="small" style={{ width: 120 }} />
        <Skeleton.Button active size="small" style={{ width: 120 }} />
      </Flexbox>
    );
  }

  return (
    <div>
      {error && data ? (
        <Alert
          showIcon
          message={t('stats.banner.refreshFailed')}
          style={{ marginBottom: 12 }}
          type="warning"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('stats.banner.retry')}
            </Button>
          }
        />
      ) : null}
      <div className={styles.banner}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatIntergerNumber(data?.usersTotal)}</span>
          <span className={styles.metricLabel}>{t('stats.banner.usersTotal')}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatIntergerNumber(data?.usersActive)}</span>
          <span className={styles.metricLabel}>
            {range
              ? t('stats.banner.usersActiveInRange', { scope: range.label })
              : t('stats.banner.usersActive')}
          </span>
        </div>
        {userName ? (
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('stats.banner.userScopeNote', { name: userName })}
          </Text>
        ) : null}
      </div>
    </div>
  );
});

GlobalStatsBanner.displayName = 'GlobalStatsBanner';
