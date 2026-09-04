'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { FilterValue } from 'antd/es/table/interface';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable, { type AdminTableChangeMeta } from '../primitives/DataTable';
import { buildAgentListColumns } from './agentListColumns';
import { AgentListLoadMore } from './AgentListLoadMore';
import { AgentListToolbar } from './AgentListToolbar';
import { deriveAdminAgentActionAvailability, deriveAdminAgentPermissions } from './controller';
import { DefaultAgentSection } from './DefaultAgentSection';
import { usePruneLegacyAdminAgentDrafts } from './pruneLegacyAgentDrafts';
import type { AdminAgentListItem } from './types';
import { useAdminAgentRefresh } from './useAdminAgentRefresh';
import { useAdminAgentListPagination, useDefaultAdminAgent } from './useAdminAgents';
import { useAgentListActions } from './useAgentListActions';
import { useAgentListSelection } from './useAgentListSelection';
import { useAgentRowActions } from './useAgentRowActions';
import { useProvisionDefaultInbox } from './useProvisionDefaultInbox';

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
  const filtered = Boolean(input.query || input.status);
  // The pinned default assistant reads through its own key, so it survives search and paging.
  const defaultAgent = useDefaultAdminAgent(agentPermissions.canRead);
  const defaultAgentMutate = defaultAgent.mutate;
  const defaultAgentId = defaultAgent.data?.item.identity.id;
  // Card and table are two cache entries over the same assistants: every write below invalidates
  // them through this one object, so no action can refresh half the screen.
  const refresh = useAdminAgentRefresh({
    refreshDefaultAgent: defaultAgentMutate,
    refreshList: list.refresh,
  });
  // 设为默认助理 / 归档助理 moved here from the removed assistant detail page. Promotion rewrites the
  // pointer itself, so it is the clearest case for invalidating both surfaces.
  const rowActions = useAgentRowActions({
    authMethod: authMethod ?? null,
    onChanged: refresh.defaultAndList,
  });
  const { clearSelection, rowSelection, selectedRows } = useAgentListSelection();
  // Archive and hard delete both sit behind AGENT_DELETE: without it the checkbox column would
  // only ever collect rows nothing can act on.
  const canBulk = agentPermissions.canDelete;
  // AGENT_ASSIGN is independently grantable: it must open the editor even without AGENT_UPDATE.
  const canOpenEditor = availability.canEdit || agentPermissions.canAssign;
  const hasRowActions = canOpenEditor || agentPermissions.canDelete || agentPermissions.canPublish;

  const { createAgent, handleBulkDone, openDelete, openEditor, openEditorForAgentId } =
    useAgentListActions({
      agentPermissions,
      authMethod,
      canEditConfig: availability.canEdit,
      clearSelection,
      defaultAgentId,
      refresh,
      removeListItem: list.removeItem,
      updateListItem: list.updateItem,
    });

  // The default assistant is never absent by choice: the server provisions it, and a settled
  // "no default" here is the window before it did — repair it instead of asking the admin to.
  const {
    failed: provisionFailed,
    provision,
    provisioning,
  } = useProvisionDefaultInbox({
    authMethod: authMethod ?? null,
    autoProvision: defaultAgent.data === null && availability.canProvisionDefaultInbox,
    refresh: refresh.defaultAndList,
  });
  // The card above already shows it in full; repeating the row would just be two truths to keep
  // in sync on screen. Rows carry `isDefault` themselves, so the duplicate is gone with the first
  // page instead of waiting on the pinned aggregate; the pointer id stays as a fallback for a row
  // whose flag is behind.
  const rows = useMemo(
    () =>
      list.items.filter(({ identity }) => !identity.isDefault && identity.id !== defaultAgentId),
    [defaultAgentId, list.items],
  );

  // Every column carries an explicit width so the table runs `tableLayout: fixed` (see `scroll.x`
  // below): under `auto`, a CJK header collapses to one character per line.
  const columns = useMemo(
    () =>
      buildAgentListColumns({
        agentPermissions,
        availability,
        canOpenEditor,
        hasRowActions,
        openDelete,
        openEditor,
        rowActions,
        status,
        t,
      }),
    [
      agentPermissions,
      availability,
      canOpenEditor,
      hasRowActions,
      openDelete,
      openEditor,
      rowActions,
      status,
      t,
    ],
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
      <DefaultAgentSection
        canEdit={canOpenEditor}
        canProvision={availability.canProvisionDefaultInbox}
        error={defaultAgent.error}
        provisionFailed={provisionFailed}
        provisioning={provisioning}
        snapshot={defaultAgent.data}
        onEdit={(agentId) => void openEditorForAgentId(agentId)}
        onProvisionRetry={() => void provision()}
        onRetry={() => void defaultAgentMutate()}
      />
      <AsyncBoundary
        data={list.boundaryData}
        error={list.error}
        isEmpty={false}
        isLoading={list.isLoadingInitial}
        loading={
          <DelayedFallback>
            <Loading debugId="AdminAgentList" variant={'inline'} />
          </DelayedFallback>
        }
        onRetry={list.retry}
      >
        <Flexbox gap={12}>
          <DataTable<AdminAgentListItem>
            columns={columns}
            dataSource={rows}
            rowKey={(item) => item.identity.id}
            rowSelection={canBulk ? rowSelection : undefined}
            // Fixed layout + horizontal scroll: honour the column widths instead of letting the
            // browser crush a CJK header to one character. The checkbox column adds its own 40px.
            scroll={{ x: canBulk ? 940 : 900 }}
            size="small"
            emptyDescription={t(
              filtered ? 'agentCatalog.list.empty.filtered' : 'agentCatalog.list.empty.default',
            )}
            toolbar={
              <AgentListToolbar
                authMethod={authMethod ?? null}
                canDelete={agentPermissions.canDelete}
                filtered={filtered}
                queryDraft={queryDraft}
                selectedRows={selectedRows}
                setQueryDraft={setQueryDraft}
                onBulkDone={handleBulkDone}
                onClearFilters={clearFilters}
                onSubmitQuery={() => patch('q', queryDraft.trim() || undefined)}
              />
            }
            onChange={handleTableChange}
            onRowActivate={canOpenEditor ? (item) => void openEditor(item) : undefined}
          />
          <AgentListLoadMore
            hasMore={list.hasMore}
            isLoadingMore={list.isLoadingMore}
            itemCount={rows.length}
            loadMore={list.loadMore}
            loadMoreError={list.loadMoreError}
            retry={list.retry}
          />
        </Flexbox>
      </AsyncBoundary>
    </AdminPageTemplate>
  );
});

AgentListPage.displayName = 'AgentListPage';

export default AgentListPage;
