'use client';

import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';

import type { AdminCursorPagination } from './DataTable';
import { DEFAULT_PAGE_SIZE_OPTIONS } from './dataTableChange';

const styles = createStaticStyles(({ css }) => ({
  cursorBar: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    margin-block-start: 12px;
  `,
}));

export interface DataTableCursorBarProps extends AdminCursorPagination {
  t: TFunction<'admin'>;
}

export const DataTableCursorBar = ({
  hasNext,
  hasPrevious,
  onNext,
  onPageSizeChange,
  onPrevious,
  pageSize,
  pageSizeOptions,
  t,
}: DataTableCursorBarProps) => (
  <div
    aria-label={t('primitives.dataTable.cursorNav')}
    className={styles.cursorBar}
    role="navigation"
  >
    {onPageSizeChange && pageSize ? (
      <Select
        aria-label={t('primitives.dataTable.pageSize')}
        style={{ minWidth: 128 }}
        value={String(pageSize)}
        options={(pageSizeOptions ?? [...DEFAULT_PAGE_SIZE_OPTIONS]).map((opt) => ({
          label: t('primitives.dataTable.pageSizeOption', { count: opt }),
          value: opt,
        }))}
        onChange={(value) => {
          onPageSizeChange(Number(value));
        }}
      />
    ) : null}
    <Button disabled={!hasPrevious} size="small" type="default" onClick={onPrevious}>
      {t('primitives.dataTable.previous')}
    </Button>
    <Button disabled={!hasNext} size="small" type="default" onClick={onNext}>
      {t('primitives.dataTable.next')}
    </Button>
  </div>
);
