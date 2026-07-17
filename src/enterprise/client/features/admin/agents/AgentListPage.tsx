'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { deriveAdminAgentPermissions } from './controller';
import { openCreateAgentModal } from './openCreateAgentModal';
import type { AdminAgentListItem } from './types';
import { refreshAdminAgentLists, useAdminAgentListPagination } from './useAdminAgents';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
}));

const readStatus = (value: string | null): AdminAgentListItem['identity']['status'] | undefined =>
  value === 'draft' || value === 'published' || value === 'archived' ? value : undefined;

const AgentListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions } = useAdminAccess();
  const agentPermissions = deriveAdminAgentPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryDraft, setQueryDraft] = useState(searchParams.get('q') ?? '');
  const status = readStatus(searchParams.get('status'));
  const input = useMemo(
    () => ({ query: searchParams.get('q') || undefined, status }),
    [searchParams, status],
  );
  const list = useAdminAgentListPagination(input, agentPermissions.canRead);
  const columns = useMemo<TableColumnsType<AdminAgentListItem>>(
    () => [
      {
        key: 'agent',
        title: t('agentCatalog.list.columns.agent'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.displayName}
            </Text>
            <Text code ellipsis type="secondary">
              {item.identity.agentKey}
            </Text>
          </div>
        ),
      },
      {
        key: 'status',
        title: t('agentCatalog.list.columns.status'),
        render: (_, item) => <StatusBadge status={item.identity.status} />,
      },
      {
        dataIndex: 'publishedVersion',
        key: 'publishedVersion',
        title: t('agentCatalog.list.columns.version'),
        render: (value: string | null) => value ?? '—',
      },
      {
        dataIndex: 'assignmentCount',
        key: 'assignmentCount',
        title: t('agentCatalog.list.columns.assignments'),
      },
      {
        key: 'isDefault',
        title: t('agentCatalog.list.columns.scope'),
        render: (_, item) => (
          <Tag>
            {item.identity.isDefault ? t('agentCatalog.defaultInbox') : t('agentCatalog.standard')}
          </Tag>
        ),
      },
    ],
    [t],
  );
  const patch = (key: 'q' | 'status', value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <AdminPageTemplate
      description={t('agentCatalog.list.description')}
      title={t('agentCatalog.list.title')}
      actions={
        agentPermissions.canCreate ? (
          <Button
            type="primary"
            onClick={() =>
              openCreateAgentModal(async (id) => {
                await refreshAdminAgentLists();
                navigate(`/admin/agents/${encodeURIComponent(id)}`);
              })
            }
          >
            {t('agentCatalog.create.submit')}
          </Button>
        ) : null
      }
      toolbar={
        <Flexbox horizontal gap={8} wrap="wrap">
          <Input
            allowClear
            aria-label={t('agentCatalog.list.search')}
            placeholder={t('agentCatalog.list.search')}
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            onPressEnter={() => patch('q', queryDraft.trim() || undefined)}
          />
          <Select
            allowClear
            aria-label={t('agentCatalog.list.status')}
            placeholder={t('agentCatalog.list.status')}
            value={status}
            options={(['draft', 'published', 'archived'] as const).map((value) => ({
              label: t(`agentCatalog.status.${value}` as never),
              value,
            }))}
            onChange={(value) => patch('status', value as string | undefined)}
          />
          <Button onClick={() => patch('q', queryDraft.trim() || undefined)}>
            {t('agentCatalog.list.applySearch')}
          </Button>
        </Flexbox>
      }
    >
      <AsyncBoundary
        data={list.items}
        error={list.error}
        isEmpty={list.isEmpty}
        isLoading={list.isLoadingInitial}
        loading={<Loading debugId="AdminAgentList" />}
        empty={t(
          searchParams.size
            ? 'agentCatalog.list.empty.filtered'
            : 'agentCatalog.list.empty.default',
        )}
        onRetry={list.retry}
      >
        <Flexbox gap={12}>
          <DataTable<AdminAgentListItem>
            columns={columns}
            dataSource={list.items}
            rowKey={(item) => item.identity.id}
            onRowActivate={(item) =>
              navigate(`/admin/agents/${encodeURIComponent(item.identity.id)}`)
            }
          />
          <Flexbox horizontal align="center" gap={8} justify="center">
            {list.hasMore ? (
              <Button loading={list.isLoadingMore} onClick={list.loadMore}>
                {list.isLoadingMore
                  ? t('agentCatalog.list.loadingMore')
                  : t('agentCatalog.list.loadMore')}
              </Button>
            ) : list.items.length > 0 ? (
              <Text type="secondary">{t('agentCatalog.list.end')}</Text>
            ) : null}
          </Flexbox>
        </Flexbox>
      </AsyncBoundary>
    </AdminPageTemplate>
  );
});

AgentListPage.displayName = 'AgentListPage';

export default AgentListPage;
