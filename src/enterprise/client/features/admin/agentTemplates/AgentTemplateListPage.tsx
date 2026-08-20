'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import { buildAgentTemplateColumns } from './agentTemplateColumns';
import AgentTemplateListToolbar from './AgentTemplateListToolbar';
import { deriveAgentTemplatePermissions } from './controller';
import { createSortableRow, SortableTable } from './SortableRow';
import type { AdminAgentTemplateItem } from './types';
import { useFetchAdminAgentTemplates } from './useAdminAgentTemplates';
import { useAgentTemplateActions } from './useAgentTemplateActions';
import { useAgentTemplateFilters } from './useAgentTemplateFilters';
import {
  AGENT_TEMPLATE_SELECTION_COLUMN_WIDTH,
  useAgentTemplateSelection,
} from './useAgentTemplateSelection';

/** Sum of the fixed column widths, without the optional selection column. */
const BASE_TABLE_WIDTH = 1176;

export interface AgentTemplateListPageProps {
  /** Rendered under an outer tabbed surface: the tab label already names the page. */
  embedded?: boolean;
}

const AgentTemplateListPage = memo<AgentTemplateListPageProps>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canCreate, canDelete, canRead, canUpdate } = deriveAgentTemplatePermissions(permissions);
  // Import both creates rows and overwrites existing content — it needs both permissions,
  // exactly like the server's compound gate.
  const canImport = canCreate && canUpdate;
  const {
    enabledParam,
    filtered,
    handleTableChange,
    input,
    page,
    pageSize,
    queryDraft,
    setPage,
    setPageSize,
    setQueryDraft,
  } = useAgentTemplateFilters();
  const { data, error, isLoading, mutate } = useFetchAdminAgentTemplates(input, canRead);
  const {
    handleBulkDelete,
    handleDelete,
    handleImport,
    handleReorder,
    handleToggle,
    importing,
    openEditor,
    pendingEnabled,
    pendingOrder,
  } = useAgentTemplateActions(data?.items);
  const { clearSelection, rowSelection, selectedRows } = useAgentTemplateSelection();
  // Bulk delete is the only bulk action, so the checkbox column is dead weight without it.
  const selectable = canDelete;

  // Dragging reassigns the sort slots of the rows on screen. Under a filter the visible rows are
  // not contiguous, so the result would be meaningless — reorder is offered on the plain list only.
  const canReorder = canUpdate && !filtered && (data?.items.length ?? 0) > 1;

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    if (!pendingOrder) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    const reordered = pendingOrder.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // Fall back to the server order if the page changed underneath the drag.
    return reordered.length === items.length ? reordered : items;
  }, [data?.items, pendingOrder]);

  // A new row component identity remounts every row, so it must only change with `canReorder`.
  const sortableRow = useMemo(() => createSortableRow(!canReorder), [canReorder]);

  const columns = useMemo(
    () =>
      buildAgentTemplateColumns({
        canDelete,
        canUpdate,
        enabledParam,
        handleDelete,
        handleToggle,
        openEditor,
        pendingEnabled,
        selectable,
        t,
      }),
    [
      canDelete,
      canUpdate,
      enabledParam,
      handleDelete,
      handleToggle,
      openEditor,
      pendingEnabled,
      selectable,
      t,
    ],
  );

  const headerActions = (
    <>
      {canImport ? (
        <Button loading={importing} onClick={handleImport}>
          {t('agentTemplateCatalog.actions.import')}
        </Button>
      ) : null}
      {canCreate ? (
        <Button type="primary" onClick={() => openEditor()}>
          {t('agentTemplateCatalog.actions.create')}
        </Button>
      ) : null}
    </>
  );

  return (
    <AdminPageTemplate
      actions={headerActions}
      description={t('agentTemplateCatalog.desc')}
      hideTitle={embedded}
      title={t('agentTemplateCatalog.title')}
    >
      {canUpdate && filtered && (data?.items.length ?? 0) > 1 ? (
        <Text type="secondary">{t('agentTemplateCatalog.list.reorderHint')}</Text>
      ) : null}
      <SortableTable ids={rows.map((row) => row.id)} onReorder={(next) => void handleReorder(next)}>
        <DataTable<AdminAgentTemplateItem>
          columns={columns}
          components={{ body: { row: sortableRow } }}
          dataSource={rows}
          error={Boolean(error) && !data}
          loading={isLoading && !data}
          rowKey="id"
          rowSelection={selectable ? rowSelection : undefined}
          emptyDescription={
            filtered
              ? t('agentTemplateCatalog.list.empty.filtered')
              : t('agentTemplateCatalog.list.empty.default')
          }
          pagination={{
            current: page,
            pageSize,
            total: data?.totalFiltered ?? 0,
          }}
          // Sum of the column widths: fixed table layout keeps CJK headers on one line and
          // scrolls horizontally instead of collapsing to one character per column, so the
          // optional checkbox column has to widen the total rather than squeeze its peers.
          // `virtual` stays off — the drag-and-drop row seam needs real `<tr>` elements.
          scroll={{
            x: selectable
              ? BASE_TABLE_WIDTH + AGENT_TEMPLATE_SELECTION_COLUMN_WIDTH
              : BASE_TABLE_WIDTH,
          }}
          toolbar={
            <AgentTemplateListToolbar
              canDelete={canDelete}
              query={queryDraft}
              selectedCount={selectedRows.length}
              onBulkDelete={() => handleBulkDelete(selectedRows, clearSelection)}
              onQueryChange={setQueryDraft}
            />
          }
          onChange={handleTableChange}
          onRetry={() => void mutate()}
          onPaginationChange={(nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          }}
        />
      </SortableTable>
      {error && data ? (
        <Alert
          showIcon
          message={t('agentTemplateCatalog.list.error.page')}
          type="error"
          extra={
            <Button onClick={() => void mutate()}>{t('agentTemplateCatalog.actions.retry')}</Button>
          }
        />
      ) : null}
    </AdminPageTemplate>
  );
});

AgentTemplateListPage.displayName = 'AdminAgentTemplateListPage';

export default AgentTemplateListPage;
