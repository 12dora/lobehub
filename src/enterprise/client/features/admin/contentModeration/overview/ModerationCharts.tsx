'use client';

import { AreaChart, BarList, DonutChart, useThemeColorRange } from '@lobehub/charts';
import dayjs from 'dayjs';
import { memo, useMemo, useState } from 'react';
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
  /** Clicking a slice of the category donut jumps to 违规记录 filtered by that category. */
  onSelectCategory: (category: string) => void;
  /** Clicking a user in the Top-10 list jumps to 违规记录 filtered by that user. */
  onSelectUser: (userId: string) => void;
}

const hasCounts = (rows: { count: number }[] | undefined): boolean =>
  Boolean(rows?.some((row) => row.count > 0));

/**
 * The five charts of 概况 (design §6.1), in two rows: stacked action trend next to the
 * category donut, then top offending users / decision sources / request kinds.
 */
const ModerationCharts = memo<ModerationChartsProps>(
  ({ data, error, loading, onRetry, onSelectCategory, onSelectUser }) => {
    const { t } = useTranslation('admin');
    const colorRange = useThemeColorRange();
    const [activeCategory, setActiveCategory] = useState<string | undefined>();

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

    // Only categories with hits make it into the donut; a zero slice is invisible anyway and
    // would steal a legend colour.
    const categoryRows = useMemo(
      () =>
        (data?.categories ?? [])
          .filter((row) => row.count > 0)
          .map((row) => ({
            category: row.category,
            count: row.count,
            name: categoryLabel(t, row.category),
          })),
      [data?.categories, t],
    );
    const categoryTotal = categoryRows.reduce((sum, row) => sum + row.count, 0);

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
        <div className={styles.chartRowPrimary}>
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

          <ChartCard
            {...shared}
            empty={categoryRows.length === 0}
            title={t('contentModeration.charts.categories')}
          >
            <div className={styles.donutLayout}>
              <DonutChart
                category="count"
                colors={colorRange}
                data={categoryRows}
                index="name"
                label={String(categoryTotal)}
                style={{ height: 200 }}
                variant="donut"
                onValueChange={(event) => {
                  const clicked = categoryRows.find((row) => row.name === event?.categoryClicked);
                  setActiveCategory(clicked?.category);
                  if (clicked) onSelectCategory(clicked.category);
                }}
              />
              <ul className={styles.donutLegend}>
                {categoryRows.map((row, index) => (
                  <li
                    className={styles.donutLegendItem}
                    data-active={activeCategory === row.category ? 'true' : undefined}
                    key={row.category}
                  >
                    <button
                      className={styles.donutLegendButton}
                      type="button"
                      onClick={() => onSelectCategory(row.category)}
                    >
                      <span
                        className={styles.donutSwatch}
                        style={{ background: colorRange[index % colorRange.length] }}
                      />
                      <span className={styles.donutLegendName}>{row.name}</span>
                      <span className={styles.donutLegendValue}>
                        {row.count} ·{' '}
                        {categoryTotal > 0 ? Math.round((row.count / categoryTotal) * 100) : 0}%
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </ChartCard>
        </div>

        <div className={styles.chartRowSecondary}>
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
