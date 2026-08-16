import { type HeatmapsProps } from '@lobehub/charts';
import { Heatmaps } from '@lobehub/charts';
import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { useSize } from 'ahooks';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { CoinsIcon, FlameIcon, MessageSquareIcon } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import { useStatsDataSource, useStatsSwrKey } from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatIntergerNumber, formatShortenNumber } from '@/utils/format';

import { HeatmapType } from '../../types';
import StatsFormGroup from '../components/StatsFormGroup';
import {
  CALENDAR_MAX_LEVEL,
  markActivityRange,
  OUT_OF_RANGE_LEVEL_OFFSET,
  resolveCalendarBlockMetrics,
  rowsInRange,
} from './activity.utils';
import ActivityHourGrid from './ActivityHourGrid';
import ActivityLegend from './ActivityLegend';
import HeatmapStats from './HeatmapStats';
import { useActivityLevelColors, useActivitySeries } from './useActivitySeries';

const styles = createStaticStyles(({ css }) => ({
  // Days outside the selected window keep their shade but recede, so the window
  // reads as a highlight on the trailing year rather than a few lonely columns.
  calendar: css`
    width: 100%;

    rect[data-level='${OUT_OF_RANGE_LEVEL_OFFSET}'],
    rect[data-level='${OUT_OF_RANGE_LEVEL_OFFSET + 1}'],
    rect[data-level='${OUT_OF_RANGE_LEVEL_OFFSET + 2}'],
    rect[data-level='${OUT_OF_RANGE_LEVEL_OFFSET + 3}'],
    rect[data-level='${OUT_OF_RANGE_LEVEL_OFFSET + 4}'] {
      opacity: 0.28;
    }
  `,
  measure: css`
    width: 100%;
    min-width: 0;
  `,
}));

const AiHeatmaps = memo<
  Omit<HeatmapsProps, 'data' | 'ref'> & { inShare?: boolean; mobile?: boolean }
>(({ inShare, mobile, ...rest }) => {
  const { t } = useTranslation('auth');
  const { getHeatmaps, getTokenHeatmaps } = useStatsDataSource();
  const [type, setType] = useState<HeatmapType>(
    inShare ? HeatmapType.Messages : HeatmapType.Tokens,
  );
  const isTokens = type === HeatmapType.Tokens;

  // The ranged path needs a data source that can answer for an arbitrary window.
  // The personal page and the share card have none, so they keep the year series.
  const { filter, range, ranged, series, view } = useActivitySeries(type, !inShare);
  const yearKey = useStatsSwrKey(statsKeys.heatmaps(type));
  const year = useClientDataSWR(ranged ? null : yearKey, async () =>
    isTokens ? getTokenHeatmaps() : getHeatmaps(),
  );

  const active = ranged ? series : year;
  // Not `!data` alone: after a terminal failure there is no data and no request in
  // flight, and calling that "loading" is what freezes the card on a skeleton.
  const isLoading = active.isLoading || (active.data === undefined && !active.error);
  const activities = useMemo(
    () => (ranged ? markActivityRange(series.data, range) : (year.data ?? [])),
    [range, ranged, series.data, year.data],
  );
  // The day tags describe the selected window, not the whole calendar behind it.
  const rangeRows = useMemo(
    () => (ranged ? rowsInRange(series.data, range) : (year.data ?? [])),
    [range, ranged, series.data, year.data],
  );

  const levelColors = useActivityLevelColors();
  // In-range palette, then the same palette again for out-of-range days (dimmed via CSS).
  const calendarColors = useMemo(() => [...levelColors, ...levelColors], [levelColors]);

  // The calendar fits itself to the width it is given, so a card that shares its row
  // with another still shows the full year instead of scrolling.
  const measureRef = useRef<HTMLDivElement>(null);
  const width = useSize(measureRef)?.width;
  const blocks = resolveCalendarBlockMetrics(width, mobile);

  const days = rangeRows.filter((item) => item.level > 0).length || '--';
  const hotDays = rangeRows.filter((item) => item.level >= 3).length || '--';

  const formatCount = (count: number) =>
    isTokens ? formatShortenNumber(count) : formatIntergerNumber(count);

  const calendarTooltip = (count: number, date: string) =>
    t(isTokens ? 'heatmaps.tooltipTokens' : 'heatmaps.tooltip', {
      count: formatCount(count),
      date,
    });

  // The calendar's copy says "on that day", which an hour bucket is not — so the hour
  // strip states the hour and the figure instead, in the same words the tabs use.
  const hourTooltip = (count: number, hour: string) =>
    [hour, '·', formatCount(count), t(isTokens ? 'stats.tokens' : 'stats.messages')].join(' ');

  const legendLabels = {
    less: t('heatmaps.legend.less'),
    more: t('heatmaps.legend.more'),
  };

  const chart =
    view === 'calendar' ? (
      <div className={styles.measure} ref={measureRef}>
        <Heatmaps
          blockMargin={blocks.blockMargin}
          blockRadius={blocks.blockRadius}
          blockSize={blocks.blockSize}
          className={cx(ranged && styles.calendar)}
          colors={ranged ? calendarColors : undefined}
          customTooltip={(activity) => calendarTooltip(activity.count, activity.date)}
          data={activities}
          hideColorLegend={ranged}
          hideTotalCount={isTokens || ranged}
          loading={isLoading}
          maxLevel={ranged ? CALENDAR_MAX_LEVEL + OUT_OF_RANGE_LEVEL_OFFSET : CALENDAR_MAX_LEVEL}
          labels={{
            legend: legendLabels,
            months: [
              t('heatmaps.months.jan'),
              t('heatmaps.months.feb'),
              t('heatmaps.months.mar'),
              t('heatmaps.months.apr'),
              t('heatmaps.months.may'),
              t('heatmaps.months.jun'),
              t('heatmaps.months.jul'),
              t('heatmaps.months.aug'),
              t('heatmaps.months.sep'),
              t('heatmaps.months.oct'),
              t('heatmaps.months.nov'),
              t('heatmaps.months.dec'),
            ],
            tooltip: isTokens ? t('heatmaps.tooltipTokens') : t('heatmaps.tooltip'),
            totalCount: isTokens ? t('heatmaps.totalCountTokens') : t('heatmaps.totalCount'),
          }}
          style={{
            alignSelf: 'center',
          }}
          {...rest}
        />
        {ranged && !isLoading ? (
          <ActivityLegend
            blockRadius={blocks.blockRadius}
            blockSize={blocks.blockSize}
            colors={levelColors}
            labels={legendLabels}
          />
        ) : null}
      </div>
    ) : (
      <ActivityHourGrid
        colors={levelColors}
        customTooltip={(cell) => hourTooltip(cell.count, cell.label)}
        data={series.data}
        labels={legendLabels}
        loading={isLoading}
        mobile={mobile}
      />
    );

  // The chart draws its own skeleton, so loading keeps rendering it; only a failed
  // first load swaps in the retryable error block.
  const content = (
    <AsyncBoundary
      data={active.data}
      error={active.error}
      isLoading={isLoading}
      loading={chart}
      onRetry={() => active.mutate()}
    >
      {chart}
    </AsyncBoundary>
  );

  const typeSwitch = (
    <Tabs
      activeKey={type}
      size={'small'}
      style={{ width: 'auto' }}
      items={[
        {
          icon: <Icon icon={CoinsIcon} />,
          key: HeatmapType.Tokens,
          label: t('stats.tokens'),
        },
        {
          icon: <Icon icon={MessageSquareIcon} />,
          key: HeatmapType.Messages,
          label: t('stats.messages'),
        },
      ]}
      onChange={(key) => setType(key as HeatmapType)}
    />
  );

  // Day counts describe a multi-day window; on an hourly window they would count
  // hours and label them "days", so they are dropped there instead.
  const dayTags =
    view === 'hour' ? null : (
      <Flexbox horizontal gap={8}>
        <Tag variant={'filled'}>{[days, t('stats.days')].join(' ')}</Tag>
        <Tag color={'success'} icon={<Icon icon={FlameIcon} />} variant={'filled'}>
          {[hotDays, t('stats.days')].join(' ')}
        </Tag>
      </Flexbox>
    );

  if (inShare) {
    return (
      <Flexbox gap={4}>
        <Flexbox horizontal align={'baseline'} gap={4} justify={'space-between'}>
          <div
            style={{
              color: cssVar.colorTextDescription,
              fontSize: 12,
            }}
          >
            {t('stats.lastYearActivity')}
          </div>
          {dayTags}
        </Flexbox>
        {content}
      </Flexbox>
    );
  }

  const title = ranged
    ? filter.rangeLabel
      ? t('stats.activityInRange', { scope: filter.rangeLabel })
      : t('stats.activity')
    : t('stats.lastYearActivity');

  return (
    <StatsFormGroup afterTitle={typeSwitch} extra={dayTags} fontSize={16} title={title}>
      <HeatmapStats />
      {content}
    </StatsFormGroup>
  );
});

export default AiHeatmaps;
