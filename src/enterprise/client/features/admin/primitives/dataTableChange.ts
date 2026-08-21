import type { TableProps } from 'antd';
import type {
  FilterValue,
  SorterResult,
  TableCurrentDataSource,
  TablePaginationConfig,
} from 'antd/es/table/interface';
import type { TFunction } from 'i18next';

import type {
  AdminCursorPagination,
  AdminTableChangeMeta,
  AdminTablePagination,
  AdminTableSort,
  AdminTableSortOrder,
} from './DataTable';

/** Single source of truth for admin list page size — every admin table/list defaults here. */
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_PAGE_SIZE_OPTIONS = ['20', '50', '100'] as const;

export const toAdminPagination = (
  pagination: false | AdminTablePagination | undefined,
): false | AdminTablePagination => {
  if (pagination === false || pagination === undefined) return false;
  return pagination;
};

export interface BuildTablePaginationOptions {
  cursorPagination?: AdminCursorPagination;
  pagination?: false | AdminTablePagination;
  t: TFunction<'admin'>;
}

export const buildTablePagination = ({
  cursorPagination,
  pagination,
  t,
}: BuildTablePaginationOptions): TablePaginationConfig | false => {
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
};

export interface CreateHandleTableChangeOptions {
  cursorPagination?: AdminCursorPagination;
  onChange?: (meta: AdminTableChangeMeta) => void;
  onPaginationChange?: (page: number, pageSize: number) => void;
  pagination?: false | AdminTablePagination;
}

export const createHandleTableChange =
  <T extends object>({
    cursorPagination,
    onChange,
    onPaginationChange,
    pagination,
  }: CreateHandleTableChangeOptions): TableProps<T>['onChange'] =>
  (pag, filters, sorter, _extra: TableCurrentDataSource<T>) => {
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
