'use client';

import { Pagination } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';

import type { AdminCursorPagination } from './DataTable';
import { buildPaginationChrome, DEFAULT_PAGE_SIZE } from './dataTableChange';

/*
 * WHY antd instead of `@lobehub/ui/base-ui` (which the house rules otherwise put first):
 * the admin numeric paginator IS antd's `Pagination` — `<Table pagination={…}>` renders one
 * internally. Rebuilding the same control out of base-ui primitives is precisely the
 * inconsistency this component exists to remove, so the cursor paginator has to be the same
 * antd component fed the same chrome (see `buildPaginationChrome`).
 */

const styles = createStaticStyles(({ css }) => ({
  /*
   * antd only applies its `.ant-table-pagination` box inside `.ant-table-wrapper`, and this
   * paginator is a sibling of the table (it must also survive the empty-page branch where no
   * table renders at all). So mirror that box here: antd uses `margin: ${margin} 0`,
   * `row-gap: ${paddingXS}` and `> * { flex: none }`, and DataTable's own root style pins
   * `.ant-table-pagination.ant-pagination` to `flex-wrap: nowrap` on top of it.
   */
  cursorBar: css`
    flex-wrap: nowrap;
    row-gap: ${cssVar.paddingXS};
    margin-block: ${cssVar.margin};

    > * {
      flex: none;
    }
  `,
}));

export interface DataTableCursorBarProps extends AdminCursorPagination {
  t: TFunction<'admin'>;
}

export const DataTableCursorBar = ({
  hasNext,
  hasPrevious,
  onJumpTo,
  onNext,
  onPageSizeChange,
  onPrevious,
  page,
  pageSize,
  pageSizeOptions,
  t,
}: DataTableCursorBarProps) => {
  const resolvedPageSize = pageSize || DEFAULT_PAGE_SIZE;
  // Owner did not track a page index: the only fact the cursor state proves is whether a
  // previous page exists, so page 2 is the honest floor when it does.
  const currentPage = page ?? (hasPrevious ? 2 : 1);
  /*
   * Keyset lists have no exact total, so none is claimed to the user (no total text, no quick
   * jumper). antd still needs a `total` to lay out page buttons, so synthesize the smallest
   * one that makes the highest reachable button exactly one past the current page — which is
   * also what makes antd disable the Next arrow at the end of the list.
   */
  const total = resolvedPageSize * (currentPage + (hasNext ? 1 : 0));

  const handleChange = (nextPage: number, nextPageSize: number) => {
    // antd fires the same callback for a page click and a page-size change; the owners all
    // reset to page 1 on a size change.
    if (nextPageSize !== resolvedPageSize) {
      onPageSizeChange?.(nextPageSize);
      return;
    }
    if (nextPage === currentPage) return;
    // Forward is structurally a single step (the synthesized total caps the last page at
    // currentPage + 1), and only `onNext` holds the next cursor.
    if (nextPage > currentPage) {
      if (hasNext) onNext();
      return;
    }
    // Backward jumps are exact when the owner retains its visited cursors; otherwise clamp to
    // one step so the control never lands somewhere other than the button that was clicked.
    if (onJumpTo) onJumpTo(nextPage);
    else onPrevious();
  };

  return (
    <Pagination
      {...buildPaginationChrome({ pageSizeOptions, t })}
      aria-label={t('primitives.dataTable.cursorNav')}
      className={styles.cursorBar}
      current={currentPage}
      pageSize={resolvedPageSize}
      role="navigation"
      showQuickJumper={false}
      showSizeChanger={Boolean(onPageSizeChange)}
      showTotal={undefined}
      total={total}
      onChange={handleChange}
    />
  );
};
