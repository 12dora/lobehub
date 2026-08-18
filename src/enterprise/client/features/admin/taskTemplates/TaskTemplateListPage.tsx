'use client';

import { Alert, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import { deriveTaskTemplatePermissions } from './controller';
import { createSortableRow, SortableTable } from './SortableRow';
import { buildTaskTemplateColumns } from './taskTemplateColumns';
import type { AdminTaskTemplateItem } from './types';
import { useFetchAdminTaskTemplates } from './useAdminTaskTemplates';
import { useTaskTemplateActions } from './useTaskTemplateActions';
import { useTaskTemplateFilters } from './useTaskTemplateFilters';

const styles = createStaticStyles(({ css }) => ({
  toolbar: css`
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-start;

    width: 100%;
  `,
  toolbarSearch: css`
    flex: 0 1 320px;
    min-width: 200px;
    max-width: 320px;
  `,
}));

const TaskTemplateListPage = memo(() => {
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
    handleDelete,
    handleImport,
    handleReorder,
    handleToggle,
    importing,
    openEditor,
    pendingEnabled,
    pendingOrder,
  } = useTaskTemplateActions(data?.items);

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
      buildTaskTemplateColumns({
        canDelete,
        canUpdate,
        enabledParam,
        handleDelete,
        handleToggle,
        language: i18n.language,
        openEditor,
        pendingEnabled,
        resolvedLanguage: i18n.resolvedLanguage,
        t,
      }),
    [
      canDelete,
      canUpdate,
      enabledParam,
      handleDelete,
      handleToggle,
      i18n.language,
      i18n.resolvedLanguage,
      openEditor,
      pendingEnabled,
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
      title={t('taskTemplateCatalog.title')}
    >
      {canUpdate && filtered && (data?.items.length ?? 0) > 1 ? (
        <Text type="secondary">{t('taskTemplateCatalog.list.reorderHint')}</Text>
      ) : null}
      <SortableTable ids={rows.map((row) => row.id)} onReorder={(next) => void handleReorder(next)}>
        <DataTable<AdminTaskTemplateItem>
          columns={columns}
          components={{ body: { row: sortableRow } }}
          dataSource={rows}
          error={Boolean(error) && !data}
          loading={isLoading && !data}
          rowKey="id"
          // Sum of the column widths: fixed table layout keeps CJK headers on one line
          // and scrolls horizontally instead of collapsing to one character per column.
          // `virtual` stays off — the drag-and-drop row seam needs real `<tr>` elements.
          scroll={{ x: 1126 }}
          emptyDescription={
            filtered
              ? t('taskTemplateCatalog.list.empty.filtered')
              : t('taskTemplateCatalog.list.empty.default')
          }
          pagination={{
            current: page,
            pageSize,
            total: data?.totalFiltered ?? 0,
          }}
          toolbar={
            <div className={styles.toolbar}>
              <div className={styles.toolbarSearch}>
                <Input
                  allowClear
                  aria-label={t('taskTemplateCatalog.list.filters.query')}
                  placeholder={t('taskTemplateCatalog.list.filters.query')}
                  style={{ width: '100%' }}
                  value={queryDraft}
                  onChange={(event) => setQueryDraft(event.target.value)}
                />
              </div>
            </div>
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
