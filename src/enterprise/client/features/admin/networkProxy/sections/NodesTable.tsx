'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminNetworkProxyNodes } from '@/enterprise/client/services/adminNetworkProxy';
import type { ProxyNodeView, SubscriptionView } from '@/types/platform/networkProxy';

import {
  enumColumnFilter,
  firstColumnFilterValue,
  searchColumnFilter,
} from '../../primitives/columnFilters';
import DataTable from '../../primitives/DataTable';
import FieldStatus from '../FieldStatus';
import { formatDelay } from '../format';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';

export interface NodesTableProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  data?: AdminNetworkProxyNodes;
  error?: unknown;
  loading?: boolean;
  /** `manual` mode turns the first column into a radio that pins the outlet to one node. */
  manualNodeName?: string;
  manualSelection: boolean;
  onRetry: () => void;
  subscriptions: SubscriptionView[];
}

interface NodeFilters {
  alive?: string;
  name?: string;
  type?: string;
}

/**
 * 节点表 (design §6.2). The rows come from the engine REST API of the instance that answered the
 * request, so the caption always names that instance — a node list is never platform-wide truth.
 */
const NodesTable = memo<NodesTableProps>(
  ({
    actions,
    canManage,
    data,
    error,
    loading,
    manualNodeName,
    manualSelection,
    onRetry,
    subscriptions,
  }) => {
    const { t } = useTranslation('admin');
    const [filters, setFilters] = useState<NodeFilters>({});

    // A latency test answers with fresh delays from the same instance; prefer those rows.
    const fresh =
      actions.latestNodes && actions.latestNodes.instanceId === data?.instanceId
        ? actions.latestNodes
        : null;
    const instanceId = data?.instanceId ?? actions.latestNodes?.instanceId ?? null;
    const rows = useMemo(() => fresh?.nodes ?? data?.nodes ?? [], [data?.nodes, fresh?.nodes]);

    const subscriptionName = useMemo(() => {
      const map = new Map(subscriptions.map((item) => [item.id, item.name]));
      return (id: string | null) => (id ? (map.get(id) ?? id) : '—');
    }, [subscriptions]);

    const filtered = useMemo(() => {
      const needle = filters.name?.trim().toLowerCase();
      return rows.filter((node) => {
        if (needle && !node.name.toLowerCase().includes(needle)) return false;
        if (filters.type && node.type !== filters.type) return false;
        if (filters.alive === 'alive' && !node.alive) return false;
        if (filters.alive === 'dead' && node.alive) return false;
        return true;
      });
    }, [filters, rows]);

    const typeOptions = useMemo(
      () =>
        [...new Set(rows.map((node) => node.type))]
          .sort()
          .map((type) => ({ label: type, value: type })),
      [rows],
    );

    const columns = useMemo<TableColumnsType<ProxyNodeView>>(
      () => [
        {
          dataIndex: 'name',
          key: 'name',
          title: t('networkProxy.nodes.columns.name'),
          ...searchColumnFilter({
            onSearch: (value) => setFilters((current) => ({ ...current, name: value })),
            placeholder: t('networkProxy.nodes.searchPlaceholder'),
            value: filters.name,
          }),
        },
        {
          dataIndex: 'type',
          key: 'type',
          title: t('networkProxy.nodes.columns.type'),
          ...enumColumnFilter({ options: typeOptions, value: filters.type }),
        },
        {
          dataIndex: 'subscriptionId',
          key: 'subscriptionId',
          render: (_: unknown, row) => subscriptionName(row.subscriptionId),
          title: t('networkProxy.nodes.columns.source'),
        },
        {
          dataIndex: 'delayMs',
          key: 'delayMs',
          render: (_: unknown, row) => formatDelay(row.delayMs),
          title: t('networkProxy.nodes.columns.delay'),
        },
        {
          dataIndex: 'alive',
          key: 'alive',
          render: (_: unknown, row) => (
            <Tag color={row.alive ? 'success' : 'default'} size="small">
              {t(row.alive ? 'networkProxy.nodes.alive' : 'networkProxy.nodes.dead')}
            </Tag>
          ),
          title: t('networkProxy.nodes.columns.alive'),
          ...enumColumnFilter({
            options: [
              { label: t('networkProxy.nodes.alive'), value: 'alive' },
              { label: t('networkProxy.nodes.dead'), value: 'dead' },
            ],
            value: filters.alive,
          }),
        },
        {
          key: 'actions',
          render: (_: unknown, row) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Button
                disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.nodeLatency(row.name))}
                loading={actions.isBusy(NETWORK_PROXY_FIELDS.nodeLatency(row.name))}
                size="small"
                onClick={() => void actions.testLatency(row.name)}
              >
                {t('networkProxy.nodes.test')}
              </Button>
              <FieldStatus actions={actions} field={NETWORK_PROXY_FIELDS.nodeLatency(row.name)} />
            </div>
          ),
          title: t('networkProxy.nodes.columns.actions'),
          width: 110,
        },
      ],
      [actions, canManage, filters, subscriptionName, t, typeOptions],
    );

    return (
      <div className={styles.stack}>
        <Text className={styles.tableCaption}>
          {instanceId
            ? t('networkProxy.nodes.caption', { instance: instanceId })
            : t('networkProxy.nodes.captionUnknown')}
        </Text>
        <DataTable<ProxyNodeView>
          columns={columns}
          dataSource={filtered}
          emptyDescription={t('networkProxy.nodes.empty')}
          error={Boolean(error)}
          loading={loading}
          pagination={false}
          rowKey="name"
          size="small"
          rowSelection={
            manualSelection
              ? {
                  getCheckboxProps: () => ({ disabled: !canManage }),
                  onChange: (keys) => {
                    const name = keys[0];
                    if (typeof name === 'string' && name !== manualNodeName) {
                      void actions.selectNode(name);
                    }
                  },
                  selectedRowKeys: manualNodeName ? [manualNodeName] : [],
                  type: 'radio',
                }
              : undefined
          }
          onRetry={onRetry}
          onChange={({ filters: next }) => {
            setFilters((current) => ({
              ...current,
              alive: firstColumnFilterValue(next.alive),
              type: firstColumnFilterValue(next.type),
            }));
          }}
        />
      </div>
    );
  },
);

NodesTable.displayName = 'NetworkProxyNodesTable';

export default NodesTable;
