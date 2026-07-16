'use client';

import { Empty, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
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

const styles = createStaticStyles(({ css }) => ({
  cursorBar: css`
    display: flex;
    flex-wrap: wrap;
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

    .ant-table-tbody > tr:focus-within {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }

    .ant-table-tbody > tr.admin-table-row-clickable {
      cursor: pointer;
    }
  `,
}));

/** Server-driven pagination state for large lists (10k+). */
export interface AdminTablePagination {
  current: number;
  pageSize: number;
  pageSizeOptions?: string[];
  showSizeChanger?: boolean;
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
    return {
      current: p.current,
      pageSize: p.pageSize,
      pageSizeOptions: p.pageSizeOptions ?? ['20', '50', '100'],
      showSizeChanger: p.showSizeChanger ?? true,
      total: p.total,
    };
  }, [cursorPagination, pagination]);

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

  if (loading) {
    return (
      <div aria-live="polite" className={cx(styles.root, styles.loading)} role="status">
        <NeuralNetworkLoading size={28} />
        <span>{t('primitives.dataTable.loading')}</span>
      </div>
    );
  }

  // Error before empty — honest failure surface even if dataSource is empty
  if (error) {
    return (
      <div className={cx(styles.root, styles.error)} role="alert">
        <span>{t('primitives.dataTable.error')}</span>
        {onRetry ? (
          <Button type="primary" onClick={onRetry}>
            {t('primitives.dataTable.retry')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (!dataSource?.length) {
    return (
      <div className={cx(styles.root, styles.empty)}>
        <Empty description={emptyDescription ?? t('primitives.dataTable.empty')} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Table<T>
        columns={columns}
        dataSource={dataSource}
        pagination={tablePagination}
        rowKey={rowKey}
        rowSelection={rowSelection}
        scroll={scroll}
        size={size}
        virtual={virtual}
        onChange={handleTableChange}
        onRow={
          onRowActivate
            ? (record) => ({
                className: 'admin-table-row-clickable',
                onClick: () => onRowActivate(record),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowActivate(record);
                  }
                },
                role: 'link',
                tabIndex: 0,
              })
            : undefined
        }
      />
      {cursorPagination ? (
        <div
          aria-label={t('primitives.dataTable.cursorNav')}
          className={styles.cursorBar}
          role="navigation"
        >
          {cursorPagination.onPageSizeChange && cursorPagination.pageSize ? (
            <select
              aria-label={t('primitives.dataTable.pageSize')}
              value={cursorPagination.pageSize}
              onChange={(e) => {
                cursorPagination.onPageSizeChange?.(Number(e.target.value));
              }}
            >
              {(cursorPagination.pageSizeOptions ?? ['20', '50', '100']).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
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
      ) : null}
    </div>
  );
}

const DataTable = memo(DataTableInner) as typeof DataTableInner & { displayName?: string };
DataTable.displayName = 'AdminDataTable';

export default DataTable;

export { Flexbox };
