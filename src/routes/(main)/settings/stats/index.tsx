'use client';

import { FormGroup, Grid, Icon } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { ProviderIcon } from '@lobehub/ui/icons';
import { type DatePickerProps } from 'antd';
import { DatePicker, Divider } from 'antd';
import dayjs from 'dayjs';
import { Brain, UserIcon } from 'lucide-react';
import { memo, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
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
import { AssistantsRank, ModelsRank, TopicsRank } from './features/rankings';
import {
  scopeStatsKey,
  type StatsDataSource,
  StatsDataSourceProvider,
  useStatsDataSource,
} from './features/StatsDataSource';
import { UsageCards, UsageTable, UsageTrends } from './features/usage';
import { AiHeatmaps } from './features/visualization';
import { GroupBy, type UserDisplayResolver } from './types';

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
   * Replace the personal Welcome banner (uses user nickname / registration
   * date) with a custom node. Pass `false` to drop the banner entirely.
   * When set (non-undefined), the personal ShareButton is also hidden because
   * the share link embeds user-identity context.
   */
  headerNode?: ReactNode | false;
  mobile?: boolean;
  /** Resolve userId → display info. Required when `enableUserDimension` is true. */
  resolveUser?: UserDisplayResolver;
  /** When false, hides the settings page title row (admin shell already has one). */
  showSettingHeader?: boolean;
}

const StatsSettingBody = memo<
  Omit<StatsSettingProps, 'dataSource'> & { showSettingHeader?: boolean }
>(({ mobile, headerNode, enableUserDimension, resolveUser, showSettingHeader = true }) => {
  const { t, i18n } = useTranslation('auth');
  dayjs.locale(i18n.language);
  const { findAndGroupByDay, scopeKey } = useStatsDataSource();

  const [groupBy, setGroupBy] = useState<GroupBy>(GroupBy.Model);
  const [dateRange, setDateRange] = useState<dayjs.Dayjs>(dayjs(new Date()));
  const [dateStrings, setDateStrings] = useState<string>();

  const { data, isLoading, error, mutate } = useClientDataSWR(
    scopeStatsKey(statsKeys.usageStat(), scopeKey),
    async () => findAndGroupByDay(dateStrings),
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

  return (
    <>
      {showSettingHeader ? <SettingHeader title={t('tab.stats')} /> : null}
      {/* ========== Header Section ========== */}
      <FormGroup
        collapsible={false}
        extra={headerNode === undefined ? <ShareButton /> : undefined}
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
        <Grid gap={16} rows={3} style={{ paddingBottom: 12 }}>
          <ModelsRank />
          <AssistantsRank mobile={mobile} />
          <TopicsRank mobile={mobile} />
        </Grid>
      </FormGroup>
      <FormGroup
        collapsible={false}
        gap={16}
        title={t('tab.usage')}
        variant={'filled'}
        extra={
          <>
            <DatePicker picker="month" value={dateRange} onChange={handleDateChange} />
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
});

const StatsSetting = memo<StatsSettingProps>(({ dataSource, ...rest }) => {
  if (!dataSource) {
    return <StatsSettingBody {...rest} />;
  }
  return (
    <StatsDataSourceProvider value={dataSource}>
      <StatsSettingBody {...rest} />
    </StatsDataSourceProvider>
  );
});

export default StatsSetting;
export type { StatsDataSource } from './features/StatsDataSource';
export {
  ADMIN_GLOBAL_STATS_SCOPE,
  PERSONAL_STATS_SCOPE,
  personalStatsDataSource,
  StatsDataSourceProvider,
} from './features/StatsDataSource';
