'use client';

import { FormGroup, Grid, Icon } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { ProviderIcon } from '@lobehub/ui/icons';
import { type DatePickerProps } from 'antd';
import { DatePicker, Divider } from 'antd';
import dayjs from 'dayjs';
import { Brain, UserIcon } from 'lucide-react';
import { memo, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import {
  type StatsDataSource,
  StatsDataSourceProvider,
  type StatsFilter,
  StatsFilterProvider,
  statsFilterUsageParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import SettingHeader from '@/routes/(main)/settings/features/SettingHeader';

import {
  ShareButton,
  TotalAssistants,
  TotalMessages,
  TotalTokens,
  TotalTopics,
  Welcome,
} from './features/overview';
import { AssistantsRank, ModelsRank, TopicsRank, UsersRank } from './features/rankings';
import { UsageCards, UsageTable, UsageTrends } from './features/usage';
import { AiHeatmaps } from './features/visualization';
import { GroupBy, type UserDisplayResolver } from './types';

/** Explicit window driving every metric on the page (admin filter bar). */
export interface StatsRange {
  endAt: string;
  /** Localized label, e.g. "Last 30 days". Used in filtered card titles. */
  label: string;
  startAt: string;
}

interface StatsSettingProps {
  /**
   * Optional stats data source. Defaults to personal user services.
   * Admin injects a platform-global source with a distinct SWR scope.
   */
  dataSource?: StatsDataSource;
  /**
   * Enable the "By User" group-by dimension in the Usage section. Only
   * meaningful when multiple users contribute to the data (i.e. workspace
   * mode). Combine with `resolveUser` to render names instead of opaque IDs.
   */
  enableUserDimension?: boolean;
  /**
   * Actions rendered at the right of the header section. Only used together with
   * `headerNode` — the personal header owns that slot with its ShareButton.
   */
  headerExtra?: ReactNode;
  /**
   * Replace the personal Welcome banner (uses user nickname / registration
   * date) with a custom node. Pass `false` to drop the banner entirely.
   * When set (non-undefined), the personal ShareButton is also hidden because
   * the share link embeds user-identity context.
   */
  headerNode?: ReactNode | false;
  mobile?: boolean;
  /**
   * Explicit time window for every metric. When set, the per-section month picker
   * is replaced by the caller's filter bar. Omit to keep the month-based behaviour.
   */
  range?: StatsRange;
  /** Resolve userId → display info. Required when `enableUserDimension` is true. */
  resolveUser?: UserDisplayResolver;
  /** When false, hides the settings page title row (admin shell already has one). */
  showSettingHeader?: boolean;
  /** Restrict every metric to a single user. */
  userId?: string;
}

type StatsSettingBodyProps = Omit<StatsSettingProps, 'dataSource' | 'range' | 'userId'> & {
  ranged?: boolean;
};

const StatsSettingBody = memo<StatsSettingBodyProps>(
  ({
    mobile,
    headerNode,
    headerExtra,
    enableUserDimension,
    ranged,
    resolveUser,
    showSettingHeader = true,
  }) => {
    const { t, i18n } = useTranslation('auth');
    dayjs.locale(i18n.language);
    const { findAndGroupByDay, rankUsers } = useStatsDataSource();
    const filter = useStatsFilter();

    const [groupBy, setGroupBy] = useState<GroupBy>(GroupBy.Model);
    const [dateRange, setDateRange] = useState<dayjs.Dayjs>(dayjs(new Date()));
    const [dateStrings, setDateStrings] = useState<string>();

    const usageStatKey = useStatsSwrKey(statsKeys.usageStat());

    const { data, isLoading, error, mutate } = useClientDataSWR(usageStatKey, async () =>
      findAndGroupByDay(statsFilterUsageParams(filter, dateStrings)),
    );

    useEffect(() => {
      if (dateStrings) {
        mutate();
      }
    }, [dateStrings]);

    const handleDateChange: DatePickerProps['onChange'] = (dates, dateStrings) => {
      // Handle both single date and array
      const actualDate = Array.isArray(dates) ? dates[0] : dates;
      if (actualDate) {
        setDateRange(actualDate);
      }
      if (typeof dateStrings === 'string') {
        setDateStrings(dateStrings);
      }
    };

    // Admin-only card. It stays when the page is pinned to one user: the ranking honours
    // the same filter, so it shows that user's row instead of vanishing under the filter.
    const showUsersRank = Boolean(rankUsers);

    return (
      <>
        {showSettingHeader ? <SettingHeader title={t('tab.stats')} /> : null}
        {/* ========== Header Section ========== */}
        <FormGroup
          collapsible={false}
          extra={headerNode === undefined ? <ShareButton /> : headerExtra}
          gap={16}
          variant={'filled'}
          title={
            headerNode === undefined ? (
              <Welcome mobile={mobile} />
            ) : headerNode === false ? undefined : (
              headerNode
            )
          }
        >
          <Grid gap={8} maxItemWidth={150} rows={4}>
            <TotalAssistants mobile={mobile} />
            <TotalTopics mobile={mobile} />
            <TotalMessages mobile={mobile} />
            <TotalTokens />
          </Grid>
          <Divider dashed />
          <AiHeatmaps mobile={mobile} />
          <Divider dashed />
          <Grid gap={16} rows={showUsersRank ? 4 : 3} style={{ paddingBottom: 12 }}>
            <ModelsRank />
            <AssistantsRank mobile={mobile} />
            <TopicsRank mobile={mobile} />
            {showUsersRank ? <UsersRank /> : null}
          </Grid>
        </FormGroup>
        <FormGroup
          collapsible={false}
          gap={16}
          title={t('tab.usage')}
          variant={'filled'}
          extra={
            <>
              {/* The caller's filter bar owns the window when `range` is set. */}
              {ranged ? null : (
                <DatePicker picker="month" value={dateRange} onChange={handleDateChange} />
              )}
              <Tabs
                activeKey={groupBy}
                style={{ marginLeft: 8 }}
                items={[
                  {
                    icon: <Icon icon={Brain} />,
                    key: GroupBy.Model,
                    label: t('usage.welcome.model'),
                  },
                  {
                    icon: <Icon icon={ProviderIcon} />,
                    key: GroupBy.Provider,
                    label: t('usage.welcome.provider'),
                  },
                  ...(enableUserDimension
                    ? [
                        {
                          icon: <Icon icon={UserIcon} />,
                          key: GroupBy.User,
                          label: t('usage.welcome.user'),
                        },
                      ]
                    : []),
                ]}
                onChange={(key) => setGroupBy(key as GroupBy)}
              />
            </>
          }
          styles={{
            title: { lineHeight: '35px' },
          }}
        >
          <AsyncBoundary data={data} error={error} errorVariant={'block'} onRetry={() => mutate()}>
            <UsageCards
              data={data}
              groupBy={groupBy}
              isLoading={isLoading}
              resolveUser={resolveUser}
            />
            <Divider />
            <UsageTrends
              data={data}
              groupBy={groupBy}
              isLoading={isLoading}
              resolveUser={resolveUser}
            />
          </AsyncBoundary>
          <div style={{ height: 24 }} />
          <UsageTable dateStrings={dateStrings} />
        </FormGroup>
      </>
    );
  },
);

const StatsSetting = memo<StatsSettingProps>(({ dataSource, range, userId, ...rest }) => {
  const filter = useMemo<StatsFilter>(
    () => ({
      endAt: range?.endAt,
      rangeLabel: range?.label,
      startAt: range?.startAt,
      userId,
    }),
    [range?.endAt, range?.label, range?.startAt, userId],
  );

  const body = <StatsSettingBody {...rest} ranged={Boolean(range)} />;
  const filtered =
    range || userId ? <StatsFilterProvider value={filter}>{body}</StatsFilterProvider> : body;

  if (!dataSource) {
    return filtered;
  }
  return <StatsDataSourceProvider value={dataSource}>{filtered}</StatsDataSourceProvider>;
});

export default StatsSetting;
export type { StatsDataSource } from '@/features/SettingsStats';
export {
  ADMIN_GLOBAL_STATS_SCOPE,
  PERSONAL_STATS_SCOPE,
  personalStatsDataSource,
  StatsDataSourceProvider,
} from '@/features/SettingsStats';
