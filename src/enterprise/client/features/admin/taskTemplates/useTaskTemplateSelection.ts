'use client';

import type { TableRowSelection } from 'antd/es/table/interface';
import { useCallback, useMemo, useState } from 'react';

import type { AdminTaskTemplateItem } from './types';

/**
 * Without an explicit width the fixed table layout splits the leftover `scroll.x` evenly
 * across width-less columns, leaving ~100px for a 16px checkbox.
 */
export const TASK_TEMPLATE_SELECTION_COLUMN_WIDTH = 40;

/**
 * Bulk-selection state for the task-template table.
 *
 * Rows are kept as a map, not as a key list: the bulk delete needs each row's CAS token
 * (`revision`), and a row selected on page 1 is no longer in `dataSource` once the operator
 * pages or searches away from it.
 */
export const useTaskTemplateSelection = () => {
  const [selectedMap, setSelectedMap] = useState<Record<string, AdminTaskTemplateItem>>({});

  const selectedRows = useMemo(() => Object.values(selectedMap), [selectedMap]);

  const clearSelection = useCallback(() => setSelectedMap({}), []);

  const rowSelection = useMemo<TableRowSelection<AdminTaskTemplateItem>>(
    () => ({
      columnWidth: TASK_TEMPLATE_SELECTION_COLUMN_WIDTH,
      preserveSelectedRowKeys: true,
      selectedRowKeys: Object.keys(selectedMap),
      onChange: (keys, rows) => {
        setSelectedMap((prev) => {
          const next: Record<string, AdminTaskTemplateItem> = {};
          const visible = new Map(
            (rows ?? []).filter(Boolean).map((row) => [row.id, row] as const),
          );
          for (const key of keys as string[]) {
            // Prefer the freshly rendered row (newer revision) over the remembered one.
            const row = visible.get(key) ?? prev[key];
            if (row) next[key] = row;
          }
          return next;
        });
      },
    }),
    [selectedMap],
  );

  return { clearSelection, rowSelection, selectedRows };
};
