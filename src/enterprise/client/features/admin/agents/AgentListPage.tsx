'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import type { FilterValue } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable, { type AdminTableChangeMeta } from '../primitives/DataTable';
import AgentListBulkActions from './AgentListBulkActions';
import { buildAgentListColumns } from './agentListColumns';
import { applyAgentSaveOutputToListItem } from './applySaveOutput';
import { deriveAdminAgentActionAvailability, deriveAdminAgentPermissions } from './controller';
import { getAdminAgentErrorMessage } from './errorPresentation';
import type { AgentEditorModalProps } from './openAgentEditorModal';
import { openAgentEditorModal } from './openAgentEditorModal';
import { openDeleteAgentModal } from './openDeleteAgentModal';
import { usePruneLegacyAdminAgentDrafts } from './pruneLegacyAgentDrafts';
import type { AdminAgentListItem } from './types';
import { fetchAdminAgentDetail, useAdminAgentListPagination } from './useAdminAgents';
import { useAgentListSelection } from './useAgentListSelection';
import { useAgentRowActions } from './useAgentRowActions';

const styles = createStaticStyles(({ css }) => ({
  toolbar: css`
    width: 100%;
  `,
  toolbarRight: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-inline-start: auto;
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
  // 设为默认助理 / 归档助理 moved here from the removed assistant detail page.
  const rowActions = useAgentRowActions({ authMethod: authMethod ?? null, onChanged: refreshList });
  const { clearSelection, rowSelection, selectedRows } = useAgentListSelection();
  // Archive and hard delete both sit behind AGENT_DELETE: without it the checkbox column would
  // only ever collect rows nothing can act on.
  const canBulk = agentPermissions.canDelete;
  // AGENT_ASSIGN is independently grantable: it must open the editor even without AGENT_UPDATE.
  const canOpenEditor = availability.canEdit || agentPermissions.canAssign;
  const hasRowActions = canOpenEditor || agentPermissions.canDelete || agentPermissions.canPublish;

  /**
   * The committed submit lands on the list. A pure config save can be applied to the one row it
   * changed; a create, or anything that wrote an assignment, changes counters the output does not
   * carry — those revalidate instead of patching a row into a half-truth.
   */
  const handleSaved = useCallback<NonNullable<AgentEditorModalProps['onSaved']>>(
    async (output, meta) => {
      try {
        if (output && !meta.created && !meta.assignmentsChanged) {
          await updateListItem(output.identity.id, (row) =>
            applyAgentSaveOutputToListItem(output, row),
          );
        } else {
          await refreshList();
        }
      } catch {
        // A failed revalidation is reported, never swallowed into a stale row.
        toast.warning(t('agentCatalog.recovery.refreshFailed'));
      }
    },
    [refreshList, t, updateListItem],
  );

  // List rows carry no draftToken or version config; both row actions load the authoritative
  // aggregate first so a stale row can never author a write against an outdated CAS.
  const openEditor = useCallback(
    async (item: AdminAgentListItem) => {
      try {
        const detail = await fetchAdminAgentDetail(item.identity.id, adminAgentsService, false);
        openAgentEditorModal({
          agent: detail,
          authMethod,
          canAssign: agentPermissions.canAssign,
          canEditConfig: availability.canEdit,
          onSaved: handleSaved,
        });
      } catch (cause) {
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [agentPermissions.canAssign, authMethod, availability.canEdit, handleSaved, t],
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

  /** One revalidation for the whole batch, then the selection is released. */
  const handleBulkDone = useCallback(async () => {
    try {
      await refreshList();
    } catch {
      toast.warning(t('agentCatalog.recovery.refreshFailed'));
    }
    clearSelection();
  }, [clearSelection, refreshList, t]);

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
  const createAgent = () =>
    openAgentEditorModal({
      authMethod,
      canAssign: agentPermissions.canAssign,
      // Coherent with delete: revalidate the infinite list via the bound mutate so the assistant
      // that is now live appears in place. There is no detail page to navigate into any more.
      onSaved: handleSaved,
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
            dataSource={list.items}
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
                <div className={styles.toolbarRight}>
                  {filtered ? (
                    <Button size="small" type="text" onClick={clearFilters}>
                      {t('primitives.filterBar.clear')}
                    </Button>
                  ) : null}
                  <AgentListBulkActions
                    authMethod={authMethod ?? null}
                    canDelete={agentPermissions.canDelete}
                    selectedRows={selectedRows}
                    onDone={handleBulkDone}
                  />
                </div>
              </Flexbox>
            }
            onChange={handleTableChange}
            onRowActivate={canOpenEditor ? (item) => void openEditor(item) : undefined}
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
