'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { enumColumnFilter } from '../primitives/columnFilters';
import DataTable, { type AdminTableChangeMeta } from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { applyAgentSaveOutputToListItem } from './applySaveOutput';
import { deriveAdminAgentActionAvailability, deriveAdminAgentPermissions } from './controller';
import { getAdminAgentErrorMessage } from './errorPresentation';
import { openAgentEditorModal } from './openAgentEditorModal';
import { openDeleteAgentModal } from './openDeleteAgentModal';
import { usePruneLegacyAdminAgentDrafts } from './pruneLegacyAgentDrafts';
import type { AdminAgentListItem } from './types';
import { fetchAdminAgentDetail, useAdminAgentListPagination } from './useAdminAgents';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  toolbar: css`
    width: 100%;
  `,
  toolbarSearch: css`
    flex: 0 1 260px;
    min-width: 180px;
    max-width: 320px;
  `,
}));

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null || first === '') return undefined;
  return String(first);
};

/**
 * Only the two live statuses are filterable. A legacy `draft` row can still exist in old
 * databases, so a stale bookmarked `?status=draft` is ignored rather than treated as a filter.
 */
const readStatus = (value: string | null): AdminAgentListItem['identity']['status'] | undefined =>
  value === 'published' || value === 'archived' ? value : undefined;

const AgentListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { authMethod, permissions } = useAdminAccess();
  const agentPermissions = deriveAdminAgentPermissions(permissions);
  const availability = deriveAdminAgentActionAvailability({ permissions: agentPermissions });
  const [searchParams, setSearchParams] = useSearchParams();
  // Saving is site-wide and immediate now — drop what the old local recovery drafts left behind.
  usePruneLegacyAdminAgentDrafts();
  const [queryDraft, setQueryDraft] = useState(searchParams.get('q') ?? '');
  const status = readStatus(searchParams.get('status'));
  const input = useMemo(
    () => ({ query: searchParams.get('q') || undefined, status }),
    [searchParams, status],
  );
  const list = useAdminAgentListPagination(input, agentPermissions.canRead);
  const refreshList = list.refresh;
  const removeListItem = list.removeItem;
  const updateListItem = list.updateItem;
  const filtered = Boolean(input.query || input.status);

  // List rows carry no draftToken or version config; both row actions load the authoritative
  // aggregate first so a stale row can never author a write against an outdated CAS.
  const openEditor = useCallback(
    async (item: AdminAgentListItem) => {
      try {
        const detail = await fetchAdminAgentDetail(item.identity.id, adminAgentsService, false);
        openAgentEditorModal({
          agent: detail,
          authMethod,
          onSaved: async (output) => {
            // The save committed: put the authoritative name / version / CAS on the row first, then
            // revalidate. A failed revalidation is reported, never swallowed into a stale row.
            try {
              await updateListItem(output.identity.id, (row) =>
                applyAgentSaveOutputToListItem(output, row),
              );
            } catch {
              toast.warning(t('agentCatalog.recovery.refreshFailed'));
            }
          },
        });
      } catch (cause) {
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [authMethod, t, updateListItem],
  );

  const openDelete = useCallback(
    async (item: AdminAgentListItem) => {
      try {
        const detail = await adminAgentsService.get({ id: item.identity.id });
        openDeleteAgentModal({
          agentId: detail.identity.id,
          authMethod: authMethod ?? undefined,
          displayName: item.displayName,
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.identity.revision,
          // Drop the committed row from bound infinite pages first so a failed refresh cannot
          // leave a still-actionable deleted assistant on screen.
          onDeleted: async () => {
            await removeListItem(detail.identity.id);
          },
        });
      } catch (cause) {
        // Preflight GET failed — never open a delete modal on unknown CAS.
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [authMethod, removeListItem, t],
  );

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
        ...enumColumnFilter({
          options: (['published', 'archived'] as const).map((value) => ({
            label: t(`agentCatalog.status.${value}` as never),
            value,
          })),
          value: status,
        }),
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
      ...(availability.canEdit || agentPermissions.canDelete
        ? [
            {
              key: 'actions',
              title: t('agentCatalog.list.columns.actions'),
              width: 140,
              render: (_: unknown, item: AdminAgentListItem) => {
                // Default / system assistants cannot be hard-deleted (server refuses too).
                const deletable = !item.identity.isDefault && item.identity.systemKey === null;
                return (
                  <Flexbox horizontal gap={4}>
                    {availability.canEdit ? (
                      <Button
                        size="small"
                        type="text"
                        onClick={(event) => {
                          // Row is clickable (navigates to detail) — keep the edit click local.
                          event.stopPropagation();
                          void openEditor(item);
                        }}
                      >
                        {t('agentCatalog.action.edit')}
                      </Button>
                    ) : null}
                    {agentPermissions.canDelete && deletable ? (
                      <Button
                        danger
                        size="small"
                        type="text"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openDelete(item);
                        }}
                      >
                        {t('agentCatalog.delete.action')}
                      </Button>
                    ) : null}
                  </Flexbox>
                );
              },
            },
          ]
        : []),
    ],
    [status, t, agentPermissions.canDelete, availability.canEdit, openDelete, openEditor],
  );
  const patch = useCallback(
    (key: 'q' | 'status', value?: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      if (!('status' in filters)) return;
      const nextStatus = firstFilterValue(filters.status);
      if (nextStatus === status) return;
      patch('status', nextStatus);
    },
    [patch, status],
  );
  const createAgent = () =>
    openAgentEditorModal({
      authMethod,
      onSaved: async (output) => {
        // Coherent with delete: revalidate the infinite list via the bound mutate, then navigate
        // into the assistant that is now live. Refresh failure must not block that navigation —
        // but it is reported, because the list the admin comes back to is then incomplete.
        try {
          await refreshList();
        } catch {
          toast.warning(t('agentCatalog.recovery.refreshFailed'));
        }
        navigate(`/admin/agents/${encodeURIComponent(output.identity.id)}`);
      },
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
        availability.canCreate ? (
          <Button type="primary" onClick={createAgent}>
            {t('agentCatalog.create.submit')}
          </Button>
        ) : null
      }
    >
      <AsyncBoundary
        data={list.boundaryData}
        error={list.error}
        isEmpty={false}
        isLoading={list.isLoadingInitial}
        loading={<Loading debugId="AdminAgentList" />}
        onRetry={list.retry}
      >
        <Flexbox gap={12}>
          <DataTable<AdminAgentListItem>
            columns={columns}
            dataSource={list.items}
            rowKey={(item) => item.identity.id}
            emptyDescription={t(
              filtered ? 'agentCatalog.list.empty.filtered' : 'agentCatalog.list.empty.default',
            )}
            toolbar={
              <Flexbox
                horizontal
                className={styles.toolbar}
                data-testid="agent-list-toolbar"
                justify="space-between"
              >
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
                {filtered ? (
                  <Button size="small" type="text" onClick={clearFilters}>
                    {t('primitives.filterBar.clear')}
                  </Button>
                ) : null}
              </Flexbox>
            }
            onChange={handleTableChange}
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
