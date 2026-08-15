import { type BarChartProps } from '@lobehub/charts';
import { Skeleton } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type UsageLog, type UsageRecordItem } from '@/types/usage/usageRecord';
import { formatNumber } from '@/utils/format';
import { getModelDisplayName, useProviderLabel } from '@/utils/modelLabels';

import { type UsageChartProps, type UserDisplayResolver } from '../../types';
import { GroupBy } from '../../types';
import StatsFormGroup from '../components/StatsFormGroup';
import { UsageBarChart } from '../components/UsageBarChart';

const recordKey = (item: UsageRecordItem, groupBy: GroupBy): string => {
  if (groupBy === GroupBy.Model) return item.model;
  if (groupBy === GroupBy.Provider) return item.provider;
  return item.userId;
};

type ProviderLabelResolver = (providerId: string) => string;

interface CategorySeries {
  /** Raw ids (model / provider / userId). These are the chart's data keys, never the label. */
  categories: string[];
  /** Raw id → the name the legend and the tooltip show for that series. */
  customCategories: Record<string, string>;
  data: BarChartProps['data'];
}

/** The human name for one series. Presentation only — it must never become a data key. */
const categoryLabel = (
  key: string,
  groupBy: GroupBy,
  providerLabel: ProviderLabelResolver,
  resolveUser?: UserDisplayResolver,
): string => {
  if (groupBy === GroupBy.User) return resolveUser ? resolveUser(key).name : key;
  if (groupBy === GroupBy.Provider) return providerLabel(key);
  return getModelDisplayName(key);
};

/**
 * Labels for the legend/tooltip, keyed by the raw id that identifies the series.
 *
 * Distinct ids can share one display name (`gpt-5-mini` and `openai/gpt-5-mini` are both
 * "GPT-5 mini"; two users can be called "Ada"). Keying the series by the label would silently merge
 * them into one bar, so the id stays the key and the raw id is appended to the *label* whenever two
 * series would otherwise read as the same thing.
 */
const buildCategoryLabels = (
  categories: string[],
  groupBy: GroupBy,
  providerLabel: ProviderLabelResolver,
  resolveUser?: UserDisplayResolver,
): Record<string, string> => {
  const labels = categories.map(
    (key) => [key, categoryLabel(key, groupBy, providerLabel, resolveUser)] as const,
  );

  const labelCount = new Map<string, number>();
  for (const [, label] of labels) labelCount.set(label, (labelCount.get(label) ?? 0) + 1);

  const result: Record<string, string> = {};
  for (const [key, label] of labels) {
    const ambiguous = (labelCount.get(label) ?? 0) > 1 && label !== key;
    result[key] = ambiguous ? `${label} (${key})` : label;
  }

  return result;
};

const groupByType = (
  data: UsageLog[],
  type: 'spend' | 'token',
  groupBy: GroupBy,
  providerLabel: ProviderLabelResolver,
  resolveUser?: UserDisplayResolver,
): CategorySeries => {
  if (!data || data?.length === 0) return { categories: [], customCategories: {}, data: [] };
  const cate: Map<string, number> = data.reduce((acc, log) => {
    if (log.records) {
      for (const item of log.records) {
        const key = recordKey(item, groupBy);
        if (key) acc.set(key, 0);
      }
    }
    return acc;
  }, new Map<string, number>());
  const categories: string[] = Array.from(cate.keys());
  const customCategories = buildCategoryLabels(categories, groupBy, providerLabel, resolveUser);
  const formattedData = data.map((log) => {
    const totalObj = {
      day: log.day,
      total: type === 'spend' ? log.totalSpend : log.totalTokens,
    };
    const todayCate = new Map<string, number>(cate);
    for (const item of log.records ?? []) {
      const key = recordKey(item, groupBy);
      if (!key) continue;
      const value = type === 'spend' ? item.spend || 0 : item.totalTokens || 0;
      let displayValue = (todayCate.get(key) || 0) + value;
      if (type === 'spend') {
        const formattedNum = formatNumber((todayCate.get(key) || 0) + value, 2);
        if (typeof formattedNum !== 'string') {
          displayValue = formattedNum;
        }
      }
      todayCate.set(key, displayValue);
    }
    return {
      ...totalObj,
      ...Object.fromEntries(todayCate.entries()),
    };
  });
  return {
    categories,
    customCategories,
    data: formattedData,
  };
};

enum ShowType {
  Spend = 'spend',
  Token = 'token',
}

const UsageTrends = memo<UsageChartProps>(({ isLoading, data, groupBy, resolveUser }) => {
  const { t } = useTranslation('auth');
  const providerLabel = useProviderLabel();

  const [type, setType] = useState<ShowType>(ShowType.Spend);

  const {
    categories: spendCate,
    customCategories: spendLabels,
    data: spendData,
  } = groupByType(data || [], 'spend', groupBy || GroupBy.Model, providerLabel, resolveUser);
  const {
    categories: tokenCate,
    customCategories: tokenLabels,
    data: tokenData,
  } = groupByType(data || [], 'token', groupBy || GroupBy.Model, providerLabel, resolveUser);

  const charts =
    data &&
    (type === ShowType.Spend ? (
      <UsageBarChart
        categories={spendCate}
        customCategories={spendLabels}
        data={spendData}
        index="day"
        showType="spend"
        stack={true}
      />
    ) : (
      <UsageBarChart
        categories={tokenCate}
        customCategories={tokenLabels}
        data={tokenData}
        index="day"
        showType="token"
        stack={true}
      />
    ));

  return (
    <StatsFormGroup
      extra={
        <Tabs
          activeKey={type}
          style={{ width: 'auto' }}
          items={[
            { key: ShowType.Spend, label: t('usage.trends.spend') },
            { key: ShowType.Token, label: t('usage.trends.tokens') },
          ]}
          onChange={(key) => setType(key as ShowType)}
        />
      }
    >
      {isLoading ? <Skeleton.Block height={280} /> : charts}
    </StatsFormGroup>
  );
});

export default UsageTrends;
