'use client';

import { Tag, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SubscriptionIssue, SubscriptionView } from '@/types/platform/networkProxy';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import DataTable from '../../primitives/DataTable';
import { isInformationalSubscriptionIssue, networkProxySubscriptionIssueKey } from '../errors';
import FieldStatus from '../FieldStatus';
import { formatDateTime, summarizeTraffic } from '../format';
import { Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { useFormatInterval } from '../useFormatInterval';
import {
  NETWORK_PROXY_FIELDS,
  type NetworkProxyActions,
  type NetworkProxySubscriptionActions,
} from '../useNetworkProxyActions';
import { openCreateSubscriptionModal } from './openSubscriptionModal';
import SubscriptionEditDrawer from './SubscriptionEditDrawer';

export interface SubscriptionsSectionProps {
  actions: NetworkProxyActions;
  canManage: boolean;
  error?: unknown;
  items: SubscriptionView[];
  loading?: boolean;
  onRetry: () => void;
  subscriptionActions: NetworkProxySubscriptionActions;
}

const SubscriptionIssueLabel = memo<{ issue: SubscriptionIssue }>(({ issue }) => {
  const { t } = useTranslation('admin');
  const informational = isInformationalSubscriptionIssue(issue.code);
  const label = (
    <Text
      className={informational ? styles.hintText : undefined}
      style={{ fontSize: 12 }}
      type={informational ? undefined : 'danger'}
    >
      {t(networkProxySubscriptionIssueKey(issue.code) as never, { detail: issue.detail ?? '' })}
    </Text>
  );
  return issue.detail ? <Tooltip title={issue.detail}>{label}</Tooltip> : label;
});

/**
 * 订阅 (design §6.3).
 *
 * The subscription URL usually carries a token, so it is only ever shown as a hostname — the
 * server never returns the full URL. Status answers one question: is this list of nodes current?
 */
const SubscriptionsSection = memo<SubscriptionsSectionProps>(
  ({ actions, canManage, error, items, loading, onRetry, subscriptionActions }) => {
    const { t } = useTranslation('admin');
    const formatInterval = useFormatInterval();
    const [editing, setEditing] = useState<SubscriptionView | null>(null);
    const rowBusy = useCallback(
      (id: string) => actions.isBusy(NETWORK_PROXY_FIELDS.subscription(id)),
      [actions],
    );

    const columns = useMemo<TableColumnsType<SubscriptionView>>(
      () => [
        {
          dataIndex: 'name',
          key: 'name',
          render: (_: unknown, row) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <Text strong>{row.name}</Text>
              {row.urlHost ? <span className={styles.code}>{row.urlHost}</span> : null}
            </div>
          ),
          title: t('networkProxy.subscriptions.columns.name'),
        },
        {
          dataIndex: 'kind',
          key: 'kind',
          render: (_: unknown, row) => t(`networkProxy.subscriptionKind.${row.kind}` as never),
          title: t('networkProxy.subscriptions.columns.kind'),
        },
        {
          dataIndex: 'nodeCount',
          key: 'nodeCount',
          render: (_: unknown, row) => row.nodeCount ?? '—',
          title: t('networkProxy.subscriptions.columns.nodeCount'),
        },
        {
          dataIndex: 'traffic',
          key: 'traffic',
          render: (_: unknown, row) => {
            const summary = summarizeTraffic(row.traffic);
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>{summary.text}</span>
                {summary.expireAt ? (
                  <span className={styles.hintText}>
                    {t('networkProxy.subscriptions.expiresAt', {
                      time: formatDateTime(summary.expireAt),
                    })}
                  </span>
                ) : null}
              </div>
            );
          },
          title: t('networkProxy.subscriptions.columns.traffic'),
        },
        {
          dataIndex: 'updateIntervalSec',
          key: 'updateIntervalSec',
          render: (_: unknown, row) =>
            row.kind === 'manual' ? '—' : formatInterval(row.updateIntervalSec),
          title: t('networkProxy.subscriptions.columns.interval'),
        },
        {
          dataIndex: 'lastUpdateAt',
          key: 'lastUpdateAt',
          render: (_: unknown, row) => formatDateTime(row.lastUpdateAt),
          title: t('networkProxy.subscriptions.columns.lastUpdate'),
        },
        {
          dataIndex: 'lastIssue',
          key: 'status',
          render: (_: unknown, row) => {
            if (!row.enabled) {
              return (
                <Tag color="default" size="small">
                  {t('networkProxy.subscriptions.status.disabled')}
                </Tag>
              );
            }
            const issue = row.lastIssue;
            const issueLabel = issue ? <SubscriptionIssueLabel issue={issue} /> : null;
            if (issue && !isInformationalSubscriptionIssue(issue.code)) {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Tag color="error" size="small">
                    {t('networkProxy.subscriptions.status.failed')}
                  </Tag>
                  {issueLabel}
                </div>
              );
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Tag color={row.lastUpdateAt ? 'success' : 'warning'} size="small">
                  {t(
                    row.lastUpdateAt
                      ? 'networkProxy.subscriptions.status.ok'
                      : 'networkProxy.subscriptions.status.pending',
                  )}
                </Tag>
                {issueLabel}
              </div>
            );
          },
          title: t('networkProxy.subscriptions.columns.status'),
        },
        {
          key: 'actions',
          render: (_: unknown, row) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div className={styles.inlineActions}>
                <Button disabled={!canManage} size="small" onClick={() => setEditing(row)}>
                  {t('networkProxy.actions.edit')}
                </Button>
                <Button
                  disabled={!canManage || rowBusy(row.id) || row.kind === 'manual'}
                  loading={rowBusy(row.id)}
                  size="small"
                  onClick={() => void subscriptionActions.refresh(row.id)}
                >
                  {t('networkProxy.subscriptions.refresh')}
                </Button>
                <Button
                  danger
                  disabled={!canManage || rowBusy(row.id)}
                  size="small"
                  onClick={() =>
                    openDangerConfirm({
                      content: t('networkProxy.subscriptions.deleteConfirmDesc', {
                        name: row.name,
                      }),
                      onConfirm: async () => {
                        await subscriptionActions.remove({ id: row.id });
                      },
                      title: t('networkProxy.subscriptions.deleteConfirmTitle'),
                    })
                  }
                >
                  {t('networkProxy.actions.delete')}
                </Button>
              </div>
              {/* A refresh / delete failure stays on the row it belongs to, with a retry. */}
              <FieldStatus
                actions={actions}
                field={NETWORK_PROXY_FIELDS.subscription(row.id)}
                pendingLabel={t('networkProxy.subscriptions.refreshing')}
                successLabel={t('networkProxy.subscriptions.refreshRequested')}
              />
            </div>
          ),
          title: t('networkProxy.subscriptions.columns.actions'),
          width: 240,
        },
      ],
      [actions, canManage, formatInterval, rowBusy, subscriptionActions, t],
    );

    return (
      <Section
        description={t('networkProxy.subscriptions.desc')}
        title={t('networkProxy.subscriptions.title')}
        actions={
          <Button
            disabled={!canManage}
            size="small"
            onClick={() =>
              openCreateSubscriptionModal({
                existing: items,
                onSubmit: subscriptionActions.create,
              })
            }
          >
            {t('networkProxy.subscriptions.create')}
          </Button>
        }
      >
        <FieldStatus
          actions={actions}
          field={NETWORK_PROXY_FIELDS.subscriptionCreate}
          pendingLabel={t('networkProxy.subscriptions.saving')}
        />
        <DataTable<SubscriptionView>
          columns={columns}
          dataSource={items}
          emptyDescription={t('networkProxy.subscriptions.empty')}
          error={Boolean(error)}
          loading={loading}
          pagination={false}
          rowKey="id"
          size="small"
          onRetry={onRetry}
        />
        <SubscriptionEditDrawer
          canManage={canManage}
          subscription={editing}
          onClose={() => setEditing(null)}
          onSubmit={subscriptionActions.update}
        />
      </Section>
    );
  },
);

SubscriptionsSection.displayName = 'NetworkProxySubscriptionsSection';

export default SubscriptionsSection;
