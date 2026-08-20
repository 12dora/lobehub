'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import { deriveTaskTemplatePermissions } from './controller';
import { createSortableRow, SortableTable } from './SortableRow';
import { buildTaskTemplateColumns } from './taskTemplateColumns';
import TaskTemplateListToolbar from './TaskTemplateListToolbar';
import type { AdminTaskTemplateItem, AdminTaskTemplateOrigin } from './types';
import { useFetchAdminTaskTemplates } from './useAdminTaskTemplates';
import { useTaskTemplateActions } from './useTaskTemplateActions';
import { useTaskTemplateFilters } from './useTaskTemplateFilters';
import {
  TASK_TEMPLATE_SELECTION_COLUMN_WIDTH,
  useTaskTemplateSelection,
} from './useTaskTemplateSelection';

/** Sum of the fixed column widths, without the optional selection column. */
const BASE_TABLE_WIDTH = 1126;

export interface TaskTemplateListPageProps {
  /** Rendered under an outer tabbed surface: the tab label already names the page. */
  embedded?: boolean;
}

const TaskTemplateListPage = memo<TaskTemplateListPageProps>(({ embedded }) => {
  const { t, i18n } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canCreate, canDelete, canRead, canUpdate } = deriveTaskTemplatePermissions(permissions);
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
  } = useTaskTemplateFilters();
  const { data, error, isLoading, mutate } = useFetchAdminTaskTemplates(input, canRead);
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
  } = useTaskTemplateActions(data?.items);
  const { clearSelection, rowSelection, selectedRows } = useTaskTemplateSelection();
  // While the catalog is empty the list previews the bundled library users are actually being
  // served. Those rows are not catalog entries — there is nothing to toggle, edit, delete or
  // reorder — so every write affordance is withdrawn until an import or a create takes it over.
  const origin: AdminTaskTemplateOrigin = data?.origin ?? 'managed';
  const unmanaged = origin === 'unmanaged';
  // Bulk delete is the only bulk action, so the checkbox column is dead weight without it.
  const selectable = canDelete && !unmanaged;

  // Dragging reassigns the sort slots of the rows on screen. Under a filter the visible rows are
  // not contiguous, so the result would be meaningless — reorder is offered on the plain list only.
  const canReorder = canUpdate && !filtered && !unmanaged && (data?.items.length ?? 0) > 1;

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
      buildTaskTemplateColumns({
        canDelete: canDelete && !unmanaged,
        canUpdate: canUpdate && !unmanaged,
        enabledParam,
        handleDelete,
        handleToggle,
        language: i18n.language,
        openEditor,
        pendingEnabled,
        resolvedLanguage: i18n.resolvedLanguage,
        selectable,
        t,
      }),
    [
      canDelete,
      canUpdate,
      enabledParam,
      unmanaged,
      handleDelete,
      handleToggle,
      i18n.language,
      i18n.resolvedLanguage,
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
          {t('taskTemplateCatalog.actions.import')}
        </Button>
      ) : null}
      {canCreate ? (
        <Button type="primary" onClick={() => openEditor()}>
          {t('taskTemplateCatalog.actions.create')}
        </Button>
      ) : null}
    </>
  );

  return (
    <AdminPageTemplate
      actions={headerActions}
      description={t('taskTemplateCatalog.desc')}
      hideTitle={embedded}
      title={t('taskTemplateCatalog.title')}
    >
      {canUpdate && filtered && !unmanaged && (data?.items.length ?? 0) > 1 ? (
        <Text type="secondary">{t('taskTemplateCatalog.list.reorderHint')}</Text>
      ) : null}
      {unmanaged ? (
        <Alert showIcon message={t('taskTemplateCatalog.list.unmanagedPreview')} type="info" />
      ) : null}
      <SortableTable ids={rows.map((row) => row.id)} onReorder={(next) => void handleReorder(next)}>
        <DataTable<AdminTaskTemplateItem>
          columns={columns}
          components={{ body: { row: sortableRow } }}
          dataSource={rows}
          error={Boolean(error) && !data}
          loading={isLoading && !data}
          rowKey="id"
          rowSelection={selectable ? rowSelection : undefined}
          emptyDescription={
            // "Import them or create your own" is the banner's job now: while the catalog is
            // unmanaged there are always preview rows, so an empty table can only be a filter miss.
            filtered || unmanaged
              ? t('taskTemplateCatalog.list.empty.filtered')
              : t('taskTemplateCatalog.list.empty.default')
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
              ? BASE_TABLE_WIDTH + TASK_TEMPLATE_SELECTION_COLUMN_WIDTH
              : BASE_TABLE_WIDTH,
          }}
          toolbar={
            <TaskTemplateListToolbar
              canDelete={selectable}
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
          message={t('taskTemplateCatalog.list.error.page')}
          type="error"
          extra={
            <Button onClick={() => void mutate()}>{t('taskTemplateCatalog.actions.retry')}</Button>
          }
        />
      ) : null}
    </AdminPageTemplate>
  );
});

TaskTemplateListPage.displayName = 'AdminTaskTemplateListPage';

export default TaskTemplateListPage;
