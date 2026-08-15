import { ModelIcon, ProviderIcon } from '@lobehub/icons';
import { ActionIcon, Avatar, Flexbox } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { MaximizeIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ImperativeModal from '@/components/ImperativeModal';
import StatisticCard from '@/components/StatisticCard';
import TitleWithPercentage from '@/components/StatisticCard/TitleWithPercentage';
import { type UsageLog } from '@/types/usage/usageRecord';
import { formatNumber } from '@/utils/format';
import { getModelDisplayName, useProviderLabel } from '@/utils/modelLabels';

import { type UsageChartProps } from '../../../../types';
import { GroupBy } from '../../../../types';
import ModelTable from './ModelTable';

const computeList = (data: UsageLog[], groupBy: GroupBy): string[] => {
  if (!data || data?.length === 0) return [];

  return Array.from(
    data.reduce((acc, log) => {
      if (log.records) {
        for (const item of log.records) {
          if (groupBy === GroupBy.Model && item.model?.length !== 0) {
            acc.add(item.model);
          }
          if (groupBy === GroupBy.Provider && item.provider?.length !== 0) {
            acc.add(item.provider);
          }
          if (groupBy === GroupBy.User && item.userId) {
            acc.add(item.userId);
          }
        }
      }
      return acc;
    }, new Set<string>()),
  );
};

const titleI18n = (
  groupBy: GroupBy,
): 'usage.activeModels.models' | 'usage.activeModels.providers' | 'usage.activeModels.users' => {
  if (groupBy === GroupBy.Model) return 'usage.activeModels.models';
  if (groupBy === GroupBy.Provider) return 'usage.activeModels.providers';
  return 'usage.activeModels.users';
};

const tableTitleI18n = (
  groupBy: GroupBy,
):
  | 'usage.activeModels.modelTable'
  | 'usage.activeModels.providerTable'
  | 'usage.activeModels.userTable' => {
  if (groupBy === GroupBy.Model) return 'usage.activeModels.modelTable';
  if (groupBy === GroupBy.Provider) return 'usage.activeModels.providerTable';
  return 'usage.activeModels.userTable';
};

const ActiveModels = memo<UsageChartProps>(({ data, isLoading, groupBy, resolveUser }) => {
  const { t } = useTranslation('auth');
  const providerLabel = useProviderLabel();

  const [open, setOpen] = useState(false);

  const iconList = useMemo(
    () => computeList(data || [], groupBy || GroupBy.Model),
    [data, groupBy],
  );

  const renderIcon = (item: string, i: number) => {
    const baseStyle = {
      border: `2px solid ${cssVar.colorBgContainer}`,
      boxSizing: 'content-box' as const,
      marginRight: -8,
      zIndex: i + 1,
    };
    if (groupBy === GroupBy.User) {
      const display = resolveUser?.(item);
      return (
        <Avatar
          avatar={display?.avatar || display?.name || item}
          background={cssVar.colorFillSecondary}
          key={item}
          shape={'circle'}
          size={18}
          style={baseStyle}
          title={display?.name || item}
        />
      );
    }
    // The row is a wall of overlapping glyphs; a hover has to answer "which model is that?".
    // The icons take no title of their own, so the name rides on a wrapper.
    const isProvider = groupBy === GroupBy.Provider;
    return (
      <span
        key={item}
        style={{ display: 'inline-flex' }}
        title={isProvider ? providerLabel(item) : getModelDisplayName(item)}
      >
        {isProvider ? (
          <ProviderIcon provider={item} size={18} style={baseStyle} />
        ) : (
          <ModelIcon model={item} size={18} style={baseStyle} />
        )}
      </span>
    );
  };

  return (
    <>
      <StatisticCard
        key={groupBy}
        loading={isLoading}
        title={<TitleWithPercentage title={t(titleI18n(groupBy ?? GroupBy.Model))} />}
        extra={
          <ActionIcon
            icon={MaximizeIcon}
            size={'small'}
            title={t(tableTitleI18n(groupBy ?? GroupBy.Model))}
            onClick={() => setOpen(true)}
          />
        }
        statistic={{
          description: (
            <Flexbox horizontal wrap={'wrap'}>
              {iconList.map((item, i) => {
                if (!item) return null;
                return renderIcon(item, i);
              })}
            </Flexbox>
          ),
          precision: 0,
          value: formatNumber(iconList?.length ?? 0),
        }}
      />
      <ImperativeModal
        footer={null}
        open={open}
        title={t(tableTitleI18n(groupBy ?? GroupBy.Model))}
        onCancel={() => setOpen(false)}
      >
        <ModelTable data={data} groupBy={groupBy} isLoading={isLoading} resolveUser={resolveUser} />
      </ImperativeModal>
    </>
  );
});

export default ActiveModels;
