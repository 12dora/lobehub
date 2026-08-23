'use client';

import { Empty } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType, TableProps } from 'antd';
import { Table } from 'antd';
import type { FilterValue, TableRowSelection } from 'antd/es/table/interface';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';

import {
  buildTablePagination,
  createHandleTableChange,
  toAdminPagination,
} from './dataTableChange';
import { DataTableCursorBar } from './DataTableCursorBar';
import { createOnRow } from './dataTableRowActivation';

const styles = createStaticStyles(({ css }) => ({
  empty: css`
    padding-block: 48px;
  `,
  error: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;

    padding-block: 48px;

    color: ${cssVar.colorTextSecondary};
  `,
  loading: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;

    min-height: 180px;

    color: ${cssVar.colorTextSecondary};
  `,
  root: css`
    width: 100%;

    .ant-table {
      background: transparent;
    }

    /* Opaque base under the translucent fill so a fixed header cell never lets the columns
       scrolling beneath it bleed through. */
    .ant-table-thead > tr > th {
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
      background-color: ${cssVar.colorBgContainer};
      background-image: linear-gradient(
        ${cssVar.colorFillQuaternary},
        ${cssVar.colorFillQuaternary}
      );
    }

    /*
     * Descendant selector (not "> tr") so virtual tables — where rows render as
     * div.ant-table-row instead of tbody > tr — get the same affordances.
     */
    .ant-table-tbody .admin-table-row-clickable {
      cursor: pointer;
    }

    /*
     * Keyboard-only focus ring on the activatable row itself.
     * Deliberately NOT :focus-within — that also fired on mouse clicks, on nested action
     * buttons, and on focus-restore after a modal closed, painting a heavy frame around a
     * (often single-row) table.
     */
    .ant-table-tbody .admin-table-row-clickable:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: -2px;
    }

    /* Page buttons + page-size select stay on one right-aligned row. */
    .ant-table-pagination.ant-pagination {
      flex-wrap: nowrap;
    }
  `,
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    margin-block-end: 12px;
  `,
}));

/** Server-driven pagination state for large lists (10k+). */
export interface AdminTablePagination {
  current: number;
  pageSize: number;
  pageSizeOptions?: string[];
  /**
   * Jump-to-page control. Defaults to `true` when `total` is a known number.
   * Do not enable this for cursor lists — use `cursorPagination` instead.
   */
  showQuickJumper?: boolean;
  showSizeChanger?: boolean;
  /**
   * Total-count line (`{{total}} items`). Defaults to `true` when `total` is a
   * finite number. Never invent a total for cursor / keyset lists.
   */
  showTotal?: boolean;
  total: number;
}

/**
 * Honest keyset/cursor pagination when exact total is unknown.
 * Renders the same paginator as `pagination` minus the two controls that would require a
 * real total (the `N items` line and the quick jumper).
 */
export interface AdminCursorPagination {
  hasNext: boolean;
  hasPrevious: boolean;
  /**
   * Exact backward jump to an already-visited page (1-based). Provide it whenever the owner
   * retains its cursor stack; without it the paginator clamps a page click to a single step.
   */
  onJumpTo?: (page: number) => void;
  onNext: () => void;
  onPageSizeChange?: (pageSize: number) => void;
  onPrevious: () => void;
  /**
   * 1-based index of the page currently shown, derived from the owner's cursor stack.
   * Omit only when the page index is genuinely not derivable.
   */
  page?: number;
  pageSize?: number;
  pageSizeOptions?: string[];
}

export type AdminTableSortOrder = 'ascend' | 'descend' | null;

export interface AdminTableSort {
  field?: string | number;
  order?: AdminTableSortOrder;
}

export interface AdminTableChangeMeta {
  filters: Record<string, FilterValue | null>;
  pagination: AdminTablePagination | false;
  sorter: AdminTableSort | AdminTableSort[];
}

export interface DataTableProps<T extends object = Record<string, unknown>> {
  columns: TableColumnsType<T>;
  /**
   * Ant Design row/cell overrides — the supported seam for drag-and-drop rows.
   * Callers own the wrapper (DndContext / SortableContext) around the table.
   */
  components?: TableProps<T>['components'];
  /**
   * Keyset cursor controls when the server does not provide an exact total.
   * Mutually exclusive with numeric `pagination` — use `pagination={false}`.
   */
  cursorPagination?: AdminCursorPagination;
  dataSource?: T[];
  emptyDescription?: ReactNode;
  error?: boolean;
  loading?: boolean;
  /** Unified change callback (pagination / sort / filter) for server-driven lists. */
  onChange?: (meta: AdminTableChangeMeta) => void;
  onPaginationChange?: (page: number, pageSize: number) => void;
  onRetry?: () => void;
  /** Row activation (click / Enter / Space). */
  onRowActivate?: (record: T) => void;
  /**
   * Controlled server pagination. Pass `false` for short client lists.
   * When an object is provided, Table stays controlled (no local page state).
   */
  pagination?: false | AdminTablePagination;
  /**
   * Extra per-row class name, merged with the built-in row classes.
   * Use for transient row states (e.g. highlighting freshly created rows).
   */
  rowClassName?: (record: T, index: number) => string | undefined;
  rowKey: TableProps<T>['rowKey'];
  rowSelection?: TableRowSelection<T>;
  /**
   * Scroll / virtualization for large datasets.
   * Prefer `scroll.y` + `virtual` for 10k-scale server pages.
   */
  scroll?: TableProps<T>['scroll'];
  /** Optional whitelist pass-through for advanced Table needs. */
  size?: TableProps<T>['size'];
  /**
   * Table-local action row rendered above the table, right-aligned.
   * Use for bulk actions. Pass a Flexbox with left + right content to split the row.
   */
  toolbar?: ReactNode;
  virtual?: boolean;
}

/**
 * Admin list table with explicit loading / empty / error states.
 * Error wins over empty. Supports controlled server pagination, sort/filter
 * propagation, row selection, and scroll/virtual for large lists.
 */
function DataTableInner<T extends object>({
  columns,
  components,
  cursorPagination,
  dataSource,
  emptyDescription,
  error,
  loading,
  onRetry,
  rowKey,
  pagination = false,
  onPaginationChange,
  onChange,
  onRowActivate,
  rowClassName,
  rowSelection,
  scroll,
  virtual,
  size = 'middle',
  toolbar,
}: DataTableProps<T>) {
  const { t } = useTranslation('admin');

  // Controlled pagination only — do **not** attach pagination.onChange here.
  // Ant Design Table fires pagination through the top-level `onChange` once;
  // a second pagination.onChange would double-invoke onPaginationChange.
  // Cursor mode always disables Ant Design numeric pagination.
  const tablePagination = useMemo(
    () => buildTablePagination({ cursorPagination, pagination, t }),
    [cursorPagination, pagination, t],
  );

  const handleTableChange = createHandleTableChange<T>({
    cursorPagination,
    onChange,
    onPaginationChange,
    pagination,
  });

  // The toolbar (search / bulk actions) stays mounted across loading / error / empty so
  // controls do not blink out of existence while a page refetches.
  const toolbarNode = toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null;

  // Merge the activation affordance class with any caller-supplied row class so both
  // survive; returning undefined keeps Ant Design's default row rendering untouched.
  const handleRow = createOnRow({ onRowActivate, rowClassName });

  if (loading) {
    return (
      <div className={styles.root}>
        {toolbarNode}
        <div aria-live="polite" className={styles.loading} role="status">
          <NeuralNetworkLoading size={28} />
          <span>{t('primitives.dataTable.loading')}</span>
        </div>
      </div>
    );
  }

  // Error before empty — honest failure surface even if dataSource is empty
  if (error) {
    return (
      <div className={styles.root}>
        {toolbarNode}
        <div className={styles.error} role="alert">
          <span>{t('primitives.dataTable.error')}</span>
          {onRetry ? (
            <Button type="primary" onClick={onRetry}>
              {t('primitives.dataTable.retry')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const numericPagination = toAdminPagination(pagination);
  // Keep numeric page controls when this page is empty but a known total remains
  // (e.g. last row deleted on page 2, or a stale empty page) so the user is not trapped.
  const keepNumericPaginationOnEmpty =
    !cursorPagination &&
    numericPagination !== false &&
    Number.isFinite(numericPagination.total) &&
    numericPagination.total > 0;

  const cursorNav =
    cursorPagination &&
    // Keep Previous/Next when the current page is empty but a prior cursor exists
    // (e.g. last row deleted on page 2) so the user is not trapped.
    (Boolean(dataSource?.length) || cursorPagination.hasPrevious || cursorPagination.hasNext) ? (
      <DataTableCursorBar t={t} {...cursorPagination} />
    ) : null;

  if (!dataSource?.length && !keepNumericPaginationOnEmpty) {
    return (
      <div className={styles.root}>
        {toolbarNode}
        <div className={styles.empty}>
          <Empty description={emptyDescription ?? t('primitives.dataTable.empty')} />
        </div>
        {cursorNav}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {toolbarNode}
      <Table<T>
        columns={columns}
        components={components}
        dataSource={dataSource}
        pagination={tablePagination}
        rowKey={rowKey}
        rowSelection={rowSelection}
        scroll={scroll}
        size={size}
        virtual={virtual}
        locale={{
          emptyText: <Empty description={emptyDescription ?? t('primitives.dataTable.empty')} />,
        }}
        onChange={handleTableChange}
        onRow={handleRow}
      />
      {cursorNav}
    </div>
  );
}

const DataTable = memo(DataTableInner) as typeof DataTableInner & { displayName?: string };
DataTable.displayName = 'AdminDataTable';

export default DataTable;
