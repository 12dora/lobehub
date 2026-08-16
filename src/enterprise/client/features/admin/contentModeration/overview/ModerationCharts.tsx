'use client';

import { AreaChart, BarChart, BarList } from '@lobehub/charts';
import dayjs from 'dayjs';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ContentModerationStatsOutput } from '@/types/platform/contentModeration';

import {
  categoryLabel,
  decisionSourceLabel,
  displayModerationUser,
  requestKindLabel,
} from '../format';
import { moderationStyles as styles } from '../styles';
import ChartCard from './ChartCard';

export interface ModerationChartsProps {
  data?: ContentModerationStatsOutput;
  error: boolean;
  loading: boolean;
  onRetry: () => void;
  /** Clicking a user in the Top-10 list jumps to 违规记录 filtered by that user. */
  onSelectUser: (userId: string) => void;
}

const hasCounts = (rows: { count: number }[] | undefined): boolean =>
  Boolean(rows?.some((row) => row.count > 0));

/**
 * The five charts of 概况 (design §6.1): stacked action trend, category distribution,
 * top offending users, decision sources, request kinds.
 */
const ModerationCharts = memo<ModerationChartsProps>(
  ({ data, error, loading, onRetry, onSelectUser }) => {
    const { t } = useTranslation('admin');

    const seriesNames = useMemo(
      () => ({
        allow: t('contentModeration.action.allow'),
        block: t('contentModeration.action.block'),
        downgrade: t('contentModeration.action.downgrade'),
        error: t('contentModeration.action.error'),
        log: t('contentModeration.action.log'),
      }),
      [t],
    );

    const trendData = useMemo(
      () =>
        (data?.series ?? []).map((point) => ({
          [seriesNames.allow]: point.allow,
          [seriesNames.block]: point.block,
          [seriesNames.downgrade]: point.downgrade,
          [seriesNames.error]: point.error,
          [seriesNames.log]: point.log,
          bucket: dayjs(point.bucketStart).format('MM-DD HH:mm'),
        })),
      [data?.series, seriesNames],
    );

    const trendEmpty = !data?.series?.some(
      (point) => point.allow + point.block + point.downgrade + point.error + point.log > 0,
    );

    const categoryData = useMemo(
      () =>
        (data?.categories ?? []).map((row) => ({
          [t('contentModeration.charts.hitCount')]: row.count,
          category: categoryLabel(t, row.category),
        })),
      [data?.categories, t],
    );

    const userBars = useMemo(
      () =>
        (data?.topUsers ?? []).map((row) => ({
          key: row.userId,
          name: displayModerationUser(
            { email: row.email, fullName: row.fullName, username: row.username },
            row.userId,
          ),
          value: row.count,
        })),
      [data?.topUsers],
    );

    const sourceBars = useMemo(
      () =>
        (data?.sources ?? []).map((row) => ({
          key: row.source,
          name: decisionSourceLabel(t, row.source),
          value: row.count,
        })),
      [data?.sources, t],
    );

    const kindBars = useMemo(
      () =>
        (data?.requestKinds ?? []).map((row) => ({
          key: row.kind,
          name: requestKindLabel(t, row.kind),
          value: row.count,
        })),
      [data?.requestKinds, t],
    );

    const shared = { error, loading, onRetry };

    return (
      <>
        <ChartCard {...shared} empty={trendEmpty} title={t('contentModeration.charts.trend')}>
          <AreaChart
            stack
            data={trendData}
            index="bucket"
            yAxisWidth={48}
            categories={[
              seriesNames.allow,
              seriesNames.log,
              seriesNames.downgrade,
              seriesNames.block,
              seriesNames.error,
            ]}
          />
        </ChartCard>

        <div className={styles.chartGrid}>
          <ChartCard
            {...shared}
            empty={!hasCounts(data?.categories)}
            title={t('contentModeration.charts.categories')}
          >
            <BarChart
              categories={[t('contentModeration.charts.hitCount')]}
              data={categoryData}
              index="category"
              layout="vertical"
              yAxisWidth={110}
            />
          </ChartCard>

          <ChartCard
            {...shared}
            empty={!hasCounts(data?.topUsers)}
            title={t('contentModeration.charts.topUsers')}
          >
            <BarList
              data={userBars}
              height={220}
              leftLabel={t('contentModeration.charts.user')}
              rightLabel={t('contentModeration.charts.hitCount')}
              onValueChange={(bar) => {
                if (typeof bar?.key === 'string') onSelectUser(bar.key);
              }}
            />
          </ChartCard>

          <ChartCard
            {...shared}
            empty={!hasCounts(data?.sources)}
            title={t('contentModeration.charts.sources')}
          >
            <BarList
              data={sourceBars}
              height={220}
              leftLabel={t('contentModeration.charts.source')}
              rightLabel={t('contentModeration.charts.hitCount')}
            />
          </ChartCard>

          <ChartCard
            {...shared}
            empty={!hasCounts(data?.requestKinds)}
            title={t('contentModeration.charts.requestKinds')}
          >
            <BarList
              data={kindBars}
              height={220}
              leftLabel={t('contentModeration.charts.requestKind')}
              rightLabel={t('contentModeration.charts.hitCount')}
            />
          </ChartCard>
        </div>
      </>
    );
  },
);

ModerationCharts.displayName = 'ModerationCharts';

export default ModerationCharts;
