'use client';

import { Empty, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { deriveAdminAgentPermissions } from './controller';
import { getAdminAgentErrorMessage } from './errorPresentation';
import { openCreateAgentModal } from './openCreateAgentModal';
import { openDeleteAgentModal } from './openDeleteAgentModal';
import type { AdminAgentListItem } from './types';
import { useAdminAgentListPagination } from './useAdminAgents';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  /**
   * Keep search + status + Search button on one row at normal desktop widths.
   * Mirrors FilterBar's flex row (wrap only when the viewport is truly narrow).
   */
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  toolbarSearch: css`
    flex: 0 1 260px;
    min-width: 180px;
    max-width: 320px;
  `,
  toolbarStatus: css`
    flex: 0 0 160px;
    min-width: 140px;
  `,
}));

const readStatus = (value: string | null): AdminAgentListItem['identity']['status'] | undefined =>
  value === 'draft' || value === 'published' || value === 'archived' ? value : undefined;

const AgentListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { authMethod, permissions } = useAdminAccess();
  const agentPermissions = deriveAdminAgentPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryDraft, setQueryDraft] = useState(searchParams.get('q') ?? '');
  const status = readStatus(searchParams.get('status'));
  const input = useMemo(
    () => ({ query: searchParams.get('q') || undefined, status }),
    [searchParams, status],
  );
  const list = useAdminAgentListPagination(input, agentPermissions.canRead);
  const refreshList = list.refresh;
  const removeListItem = list.removeItem;
  const filtered = Boolean(input.query || input.status);
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
      ...(agentPermissions.canDelete
        ? [
            {
              key: 'actions',
              title: t('agentCatalog.list.columns.actions'),
              width: 96,
              render: (_: unknown, item: AdminAgentListItem) => {
                // Default / system assistants cannot be hard-deleted (server refuses too).
                const deletable = !item.identity.isDefault && item.identity.systemKey === null;
                if (!deletable) return null;
                return (
                  <Button
                    danger
                    size="small"
                    type="text"
                    onClick={(event) => {
                      // Row is clickable (navigates to detail) — keep the delete click local.
                      event.stopPropagation();
                      // List rows lack draftToken; fetch authoritative identity CAS before confirm
                      // so concurrent version/assignment edits cannot be wiped by a stale list row.
                      void (async () => {
                        try {
                          const detail = await adminAgentsService.get({ id: item.identity.id });
                          openDeleteAgentModal({
                            agentId: detail.identity.id,
                            authMethod: authMethod ?? undefined,
                            displayName: item.displayName,
                            expectedDraftToken: detail.draftToken,
                            expectedRevision: detail.identity.revision,
                            // Drop the committed row from bound infinite pages first so a failed
                            // refresh cannot leave a still-actionable deleted assistant.
                            onDeleted: async () => {
                              await removeListItem(detail.identity.id);
                            },
                          });
                        } catch (cause) {
                          // Preflight GET failed — never open a delete modal on unknown CAS, and
                          // never leave an unhandled rejection.
                          toast.error(getAdminAgentErrorMessage(cause, t));
                        }
                      })();
                    }}
                  >
                    {t('agentCatalog.delete.action')}
                  </Button>
                );
              },
            },
          ]
        : []),
    ],
    [t, agentPermissions.canDelete, authMethod, removeListItem],
  );
  const patch = (key: 'q' | 'status', value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const createAgent = () =>
    openCreateAgentModal(async (id) => {
      // Coherent with delete: revalidate the infinite list via the bound mutate, then navigate.
      // Refresh failure must not block entry into the new assistant detail.
      try {
        await refreshList();
      } catch {
        // list will revalidate on next visit / focus; navigation is still valid post-create
      }
      navigate(`/admin/agents/${encodeURIComponent(id)}`);
    });
  const clearFilters = () => {
    setQueryDraft('');
    setSearchParams({}, { replace: true });
  };

  return (
    <AdminPageTemplate
      description={t('agentCatalog.list.description')}
      title={t('agentCatalog.list.title')}
      actions={
        agentPermissions.canCreate ? (
          <Button type="primary" onClick={createAgent}>
            {t('agentCatalog.create.submit')}
          </Button>
        ) : null
      }
      toolbar={
        <div className={styles.toolbar} data-testid="agent-list-toolbar">
          <div className={styles.toolbarSearch}>
            <Input
              allowClear
              aria-label={t('agentCatalog.list.search')}
              placeholder={t('agentCatalog.list.search')}
              style={{ width: '100%' }}
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              onPressEnter={() => patch('q', queryDraft.trim() || undefined)}
            />
          </div>
          <div className={styles.toolbarStatus}>
            <Select
              allowClear
              aria-label={t('agentCatalog.list.status')}
              placeholder={t('agentCatalog.list.status')}
              style={{ width: '100%' }}
              value={status}
              options={(['draft', 'published', 'archived'] as const).map((value) => ({
                label: t(`agentCatalog.status.${value}` as never),
                value,
              }))}
              onChange={(value) => patch('status', value as string | undefined)}
            />
          </div>
          <Button onClick={() => patch('q', queryDraft.trim() || undefined)}>
            {t('agentCatalog.list.applySearch')}
          </Button>
        </div>
      }
    >
      <AsyncBoundary
        data={list.boundaryData}
        error={list.error}
        isEmpty={list.isEmpty}
        isLoading={list.isLoadingInitial}
        loading={<Loading debugId="AdminAgentList" />}
        empty={
          <Empty
            action={
              filtered ? (
                <Button onClick={clearFilters}>{t('primitives.filterBar.clear')}</Button>
              ) : agentPermissions.canCreate ? (
                <Button type="primary" onClick={createAgent}>
                  {t('agentCatalog.create.submit')}
                </Button>
              ) : undefined
            }
            description={t(
              filtered ? 'agentCatalog.list.empty.filtered' : 'agentCatalog.list.empty.default',
            )}
          />
        }
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
            {list.loadMoreError ? (
              <Flexbox horizontal align="center" gap={8}>
                <Text type="danger">{t('agentCatalog.list.loadMoreError')}</Text>
                <Button onClick={list.retry}>{t('agentCatalog.dependency.retry')}</Button>
              </Flexbox>
            ) : list.hasMore ? (
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
