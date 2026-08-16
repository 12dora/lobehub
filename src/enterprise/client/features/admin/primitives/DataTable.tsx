'use client';

import { Empty } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import type { TableColumnsType, TableProps } from 'antd';
import { Table } from 'antd';
import type {
  FilterValue,
  SorterResult,
  TableCurrentDataSource,
  TablePaginationConfig,
  TableRowSelection,
} from 'antd/es/table/interface';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';

/**
 * True when the event target is (or sits inside) a *nested* interactive control.
 * The row itself often uses role="link" for keyboard a11y — that must still activate.
 * Nested buttons/links/inputs must not also trigger row activation.
 */
const isInteractiveDescendantTarget = (
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean => {
  if (!(target instanceof Element) || !(currentTarget instanceof Element)) return false;
  const interactive = target.closest(
    'a, button, input, select, textarea, label, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="textbox"], [contenteditable="true"]',
  );
  if (!interactive || interactive === currentTarget) return false;
  return currentTarget.contains(interactive);
};

const styles = createStaticStyles(({ css }) => ({
  cursorBar: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    margin-block-start: 12px;
  `,
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

    .ant-table-thead > tr > th {
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
      background: ${cssVar.colorFillQuaternary};
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

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE_OPTIONS = ['20', '50', '100'] as const;

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
 * Renders previous/next controls without inventing an offset total.
 */
export interface AdminCursorPagination {
  hasNext: boolean;
  hasPrevious: boolean;
  onNext: () => void;
  onPageSizeChange?: (pageSize: number) => void;
  onPrevious: () => void;
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

const toAdminPagination = (
  pagination: false | AdminTablePagination | undefined,
): false | AdminTablePagination => {
  if (pagination === false || pagination === undefined) return false;
  return pagination;
};

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
  const tablePagination = useMemo((): TablePaginationConfig | false => {
    if (cursorPagination) return false;
    const p = toAdminPagination(pagination);
    if (!p) return false;
    const totalKnown = typeof p.total === 'number' && Number.isFinite(p.total);
    const showTotal = p.showTotal ?? totalKnown;
    return {
      align: 'end',
      current: p.current,
      locale: {
        items_per_page: t('primitives.dataTable.itemsPerPage'),
        jump_to: t('primitives.dataTable.jumpTo'),
        next_page: t('primitives.dataTable.nextPage'),
        page: t('primitives.dataTable.page'),
        prev_page: t('primitives.dataTable.prevPage'),
      },
      pageSize: p.pageSize || DEFAULT_PAGE_SIZE,
      pageSizeOptions: p.pageSizeOptions ?? [...DEFAULT_PAGE_SIZE_OPTIONS],
      placement: ['bottomEnd'],
      showQuickJumper: p.showQuickJumper ?? totalKnown,
      showSizeChanger: p.showSizeChanger ?? true,
      showTotal: showTotal ? (total) => t('primitives.dataTable.showTotal', { total }) : undefined,
      total: p.total,
    };
  }, [cursorPagination, pagination, t]);

  const handleTableChange: TableProps<T>['onChange'] = (
    pag,
    filters,
    sorter,
    _extra: TableCurrentDataSource<T>,
  ) => {
    const currentPagination = toAdminPagination(pagination);

    let nextPagination: AdminTablePagination | false = false;
    if (!cursorPagination && currentPagination !== false) {
      const nextPageSize = pag.pageSize ?? currentPagination.pageSize;
      const pageSizeChanged = nextPageSize !== currentPagination.pageSize;
      // Server-driven lists: page-size change always resets to page 1.
      const nextCurrent = pageSizeChanged ? 1 : (pag.current ?? currentPagination.current);
      nextPagination = {
        ...currentPagination,
        current: nextCurrent,
        pageSize: nextPageSize,
      };
    }

    // Single path for pagination callbacks (page number or page size).
    if (
      nextPagination !== false &&
      currentPagination !== false &&
      onPaginationChange &&
      (nextPagination.current !== currentPagination.current ||
        nextPagination.pageSize !== currentPagination.pageSize)
    ) {
      onPaginationChange(nextPagination.current, nextPagination.pageSize);
    }

    const normalizeSorter = (
      value: SorterResult<T> | SorterResult<T>[],
    ): AdminTableSort | AdminTableSort[] => {
      if (Array.isArray(value)) {
        return value.map((s) => ({
          field: s.field as string | number | undefined,
          order: (s.order ?? null) as AdminTableSortOrder,
        }));
      }
      return {
        field: value.field as string | number | undefined,
        order: (value.order ?? null) as AdminTableSortOrder,
      };
    };

    // Unified meta for sort/filter/pagination (callers may use this alone).
    onChange?.({
      filters: filters as Record<string, FilterValue | null>,
      pagination: nextPagination,
      sorter: normalizeSorter(sorter),
    });
  };

  // The toolbar (search / bulk actions) stays mounted across loading / error / empty so
  // controls do not blink out of existence while a page refetches.
  const toolbarNode = toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null;

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
      <div
        aria-label={t('primitives.dataTable.cursorNav')}
        className={styles.cursorBar}
        role="navigation"
      >
        {cursorPagination.onPageSizeChange && cursorPagination.pageSize ? (
          <Select
            aria-label={t('primitives.dataTable.pageSize')}
            style={{ minWidth: 128 }}
            value={String(cursorPagination.pageSize)}
            options={(cursorPagination.pageSizeOptions ?? [...DEFAULT_PAGE_SIZE_OPTIONS]).map(
              (opt) => ({
                label: t('primitives.dataTable.pageSizeOption', { count: opt }),
                value: opt,
              }),
            )}
            onChange={(value) => {
              cursorPagination.onPageSizeChange?.(Number(value));
            }}
          />
        ) : null}
        <Button
          disabled={!cursorPagination.hasPrevious}
          size="small"
          type="default"
          onClick={cursorPagination.onPrevious}
        >
          {t('primitives.dataTable.previous')}
        </Button>
        <Button
          disabled={!cursorPagination.hasNext}
          size="small"
          type="default"
          onClick={cursorPagination.onNext}
        >
          {t('primitives.dataTable.next')}
        </Button>
      </div>
    ) : null;

  if (!dataSource?.length && !keepNumericPaginationOnEmpty) {
    return (
      <div className={cx(styles.root, styles.empty)}>
        {toolbarNode}
        <Empty description={emptyDescription ?? t('primitives.dataTable.empty')} />
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
        onRow={
          onRowActivate
            ? (record) => ({
                className: 'admin-table-row-clickable',
                onClick: (event) => {
                  if (event.defaultPrevented) return;
                  if (isInteractiveDescendantTarget(event.target, event.currentTarget)) return;
                  onRowActivate(record);
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  if (event.defaultPrevented) return;
                  // Nested controls own their keyboard activation; do not also navigate the row.
                  if (isInteractiveDescendantTarget(event.target, event.currentTarget)) return;
                  event.preventDefault();
                  onRowActivate(record);
                },
                role: 'link',
                tabIndex: 0,
              })
            : undefined
        }
      />
      {cursorNav}
    </div>
  );
}

const DataTable = memo(DataTableInner) as typeof DataTableInner & { displayName?: string };
DataTable.displayName = 'AdminDataTable';

export default DataTable;
