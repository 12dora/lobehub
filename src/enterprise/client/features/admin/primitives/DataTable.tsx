'use client';

import { Empty, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType, TableProps } from 'antd';
import { Table } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';

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

    .ant-table-thead > tr > th {
      font-weight: 600;
      color: ${cssVar.colorTextSecondary};
      background: ${cssVar.colorFillQuaternary};
    }

    .ant-table-tbody > tr:focus-within {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
}));

export interface DataTableProps<T extends object = Record<string, unknown>> {
  columns: TableColumnsType<T>;
  dataSource?: T[];
  emptyDescription?: ReactNode;
  error?: boolean;
  loading?: boolean;
  onRetry?: () => void;
  /** Optional pagination; omit for client-only short lists. */
  pagination?: TableProps<T>['pagination'];
  rowKey: TableProps<T>['rowKey'];
}

/**
 * Admin list table with explicit loading / empty / error states.
 * Uses antd Table (no base-ui equivalent) + project loaders / Empty.
 */
function DataTableInner<T extends object>({
  columns,
  dataSource,
  emptyDescription,
  error,
  loading,
  onRetry,
  rowKey,
  pagination = false,
}: DataTableProps<T>) {
  const { t } = useTranslation('admin');

  if (loading) {
    return (
      <div aria-live="polite" className={cx(styles.root, styles.loading)} role="status">
        <NeuralNetworkLoading size={28} />
        <span>{t('primitives.dataTable.loading')}</span>
      </div>
    );
  }

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
        pagination={pagination}
        rowKey={rowKey}
        size="middle"
      />
    </div>
  );
}

const DataTable = memo(DataTableInner) as typeof DataTableInner & { displayName?: string };
DataTable.displayName = 'AdminDataTable';

export default DataTable;

// re-export Flexbox for layout composition in callers
export { Flexbox };
