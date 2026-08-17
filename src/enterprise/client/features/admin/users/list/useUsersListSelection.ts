'use client';

import type { TableRowSelection } from 'antd/es/table/interface';
import { useCallback, useMemo, useState } from 'react';

import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';

import type { BulkUserTarget } from '../modals/bulkActions';
import { displayUserName } from '../utils';

export type AdminUserListItem = AdminUsersListOutput['items'][number];

interface UseUsersListSelectionParams {
  currentUserId?: string;
  selfActionDisabledTitle: string;
}

export const useUsersListSelection = ({
  currentUserId,
  selfActionDisabledTitle,
}: UseUsersListSelectionParams) => {
  const [selectedMap, setSelectedMap] = useState<Record<string, AdminUserListItem>>({});

  const selectedRows = useMemo(
    () => Object.values(selectedMap).filter((row) => row.id !== currentUserId),
    [currentUserId, selectedMap],
  );

  const toBulkTargets = useCallback(
    (rows: AdminUserListItem[]): BulkUserTarget[] =>
      rows.map((row) => ({
        currentRoles: row.roles,
        id: row.id,
        label: displayUserName(row),
      })),
    [],
  );

  const clearSelection = useCallback(() => {
    setSelectedMap({});
  }, []);

  const rowSelection: TableRowSelection<AdminUserListItem> = {
    // Without an explicit width the fixed table layout splits the leftover `scroll.x`
    // evenly across width-less columns, leaving ~100px for a 16px checkbox.
    columnWidth: 48,
    getCheckboxProps: (row) => ({
      disabled: row.id === currentUserId,
      title: row.id === currentUserId ? selfActionDisabledTitle : undefined,
    }),
    preserveSelectedRowKeys: true,
    selectedRowKeys: Object.keys(selectedMap),
    onChange: (keys, rows) => {
      setSelectedMap((prev) => {
        const next: Record<string, AdminUserListItem> = {};
        const visible = new Map(rows.map((row) => [row.id, row]));
        for (const key of keys as string[]) {
          if (key === currentUserId) continue;
          const row = visible.get(key) ?? prev[key];
          if (row) next[key] = row;
        }
        return next;
      });
    },
  };

  return {
    clearSelection,
    rowSelection,
    selectedRows,
    toBulkTargets,
  };
};
