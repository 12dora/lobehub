import { ProviderIcon } from '@lobehub/icons';
import { Flexbox, Tag, Text } from '@lobehub/ui';
import { type TableColumnType } from 'antd';
import { cssVar } from 'antd-style';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import InlineTable from '@/components/InlineTable';
import {
  statsFilterUsageParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { parseAsInteger, useQueryParam } from '@/hooks/useQueryParam';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { formatDate, formatNumber } from '@/utils/format';
import { getModelDisplayName, useProviderLabel } from '@/utils/modelLabels';

import { type UsageChartProps } from '../../types';

const UsageTable = memo<UsageChartProps>(({ dateStrings }) => {
  const { t } = useTranslation('auth');
  const providerLabel = useProviderLabel();
  const { findByMonth } = useStatsDataSource();
  const filter = useStatsFilter();
  const swrKey = useStatsSwrKey(statsKeys.usageLogs());

  const { data, error, isLoading, mutate } = useClientDataSWR(swrKey, async () =>
    findByMonth(statsFilterUsageParams(filter, dateStrings)),
  );

  const [currentPage, setCurrentPage] = useQueryParam('current', parseAsInteger.withDefault(1), {
    clearOnDefault: true,
  });
  const [pageSize, setPageSize] = useQueryParam('pageSize', parseAsInteger.withDefault(5), {
    clearOnDefault: true,
  });

  useEffect(() => {
    if (dateStrings) {
      mutate();
    }
  }, [dateStrings]);

  /**
   * Changing the admin range or the selected user replaces the row set, so a `current`
   * page carried over from the previous filter can point past the end of the new one —
   * a blank table with no hint why. Reset to the first page on every filter change.
   *
   * Seeded from the first render and gated on an actual page move, so the personal /
   * workspace page (no filter, no provider) never touches its URL.
   */
  const filterSignature = `${filter.startAt ?? ''}|${filter.endAt ?? ''}|${filter.userId ?? ''}`;
  const lastFilterSignature = useRef(filterSignature);
  useEffect(() => {
    if (lastFilterSignature.current === filterSignature) return;
    lastFilterSignature.current = filterSignature;
    if (currentPage !== 1) setCurrentPage(1);
  }, [filterSignature, currentPage, setCurrentPage]);

  const columns: TableColumnType<any>[] = [
    {
      hidden: true,
      key: 'id',
      title: 'ID',
    },
    {
      dataIndex: 'model',
      key: 'model',
      render: (value, record) => {
        const model = getModelDisplayName(value, record.provider);
        const provider = providerLabel(record.provider);
        return (
          <Flexbox horizontal align={'start'} gap={16}>
            <ProviderIcon
              provider={record.provider}
              size={18}
              style={{
                border: `2px solid ${cssVar.colorBgContainer}`,
                boxSizing: 'content-box',
                marginRight: -8,
              }}
            />
            {/* Truncated by width, not by character count, so a long name still fills the column. */}
            <Text
              ellipsis={{ tooltip: provider ? `${model} · ${provider}` : model }}
              style={{ maxWidth: 200 }}
            >
              {model}
            </Text>
          </Flexbox>
        );
      },
      title: t('usage.table.model'),
    },
    {
      dataIndex: 'type',
      filters: [
        {
          text: 'Chat',
          value: 'chat',
        },
      ],
      key: 'type',
      onFilter: (value, record) => record.callType === value,
      render: (value) => {
        return <Tag>{value}</Tag>;
      },
      title: t('usage.table.type'),
    },
    {
      dataIndex: 'totalInputTokens',
      key: 'inputTokens',
      title: t('usage.table.inputTokens'),
    },
    {
      dataIndex: 'totalOutputTokens',
      key: 'outputTokens',
      title: t('usage.table.outputTokens'),
    },
    {
      dataIndex: 'tps',
      key: 'tps',
      render: (value) => formatNumber(value, 2),
      title: t('usage.table.tps'),
    },
    {
      dataIndex: 'ttft',
      key: 'ttft',
      render: (value) => formatNumber(value / 1000, 2),
      title: t('usage.table.ttft'),
    },
    {
      dataIndex: 'spend',
      key: 'spend',
      render: (value) => {
        return `$${formatNumber(value, 6)}`;
      },
      title: t('usage.table.spend'),
    },
    {
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value) => {
        return formatDate(new Date(value));
      },
      sortDirections: ['descend'],
      sorter: (a, b) => a.createdAt - b.createdAt,
      title: t('usage.table.createdAt'),
    },
  ];

  // A wide custom range can exceed the server's full-fetch ceiling and reject the
  // query — without this the failure would render as a confident empty table.
  return (
    <AsyncBoundary data={data} error={error} errorVariant={'block'} onRetry={() => mutate()}>
      <InlineTable
        columns={columns}
        dataSource={data}
        loading={isLoading}
        rowKey={(record) => record.id || `${record.model}-${record.createdAt}-${record.provider}`}
        size="small"
        pagination={{
          current: currentPage,
          onChange: (page) => {
            setCurrentPage(page);
          },
          onShowSizeChange: (current, size) => {
            setCurrentPage(current);
            setPageSize(size);
          },
          pageSize,
        }}
      />
    </AsyncBoundary>
  );
});

export default UsageTable;
