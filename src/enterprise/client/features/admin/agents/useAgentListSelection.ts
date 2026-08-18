'use client';

import type { TableRowSelection } from 'antd/es/table/interface';
import { useCallback, useMemo, useState } from 'react';

import type { AdminAgentListItem } from './types';

/**
 * Bulk selection for the platform-assistant table.
 *
 * The list is cursor-paged and rows are dropped from the DOM as pages scroll, so the selection is
 * kept as a `id -> row` map (with `preserveSelectedRowKeys`) instead of a key array: the bulk
 * actions need the row's status / isDefault / systemKey to decide eligibility even after its page
 * is no longer rendered.
 */
export const useAgentListSelection = () => {
  const [selectedMap, setSelectedMap] = useState<Record<string, AdminAgentListItem>>({});

  const selectedRows = useMemo(() => Object.values(selectedMap), [selectedMap]);

  const clearSelection = useCallback(() => {
    setSelectedMap({});
  }, []);

  const rowSelection = useMemo<TableRowSelection<AdminAgentListItem>>(
    () => ({
      // Without an explicit width the fixed table layout splits the leftover `scroll.x`
      // evenly across width-less columns, leaving ~100px for a 16px checkbox.
      columnWidth: 40,
      preserveSelectedRowKeys: true,
      selectedRowKeys: Object.keys(selectedMap),
      onChange: (keys, rows) => {
        setSelectedMap((prev) => {
          const next: Record<string, AdminAgentListItem> = {};
          // Rows outside the rendered pages come back as holes — keep the previously stored row.
          const visible = new Map(
            rows.filter(Boolean).map((row) => [row.identity.id, row] as const),
          );
          for (const key of keys as string[]) {
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
