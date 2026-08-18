'use client';

import { Text } from '@lobehub/ui';
import { Button, type DropdownItem, DropdownMenu } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import {
  openBulkArchiveAgentsModal,
  openBulkDeleteAgentsModal,
  selectArchivableAgents,
  selectDeletableAgents,
} from './bulkAgentActions';
import type { AdminAgentListItem } from './types';

export interface AgentListBulkActionsProps {
  authMethod: AdminReauthAuthMethod | null;
  /** AGENT_DELETE — the permission behind both archive and hard delete. */
  canDelete: boolean;
  /** Revalidate the list and drop the selection once the batch settles. */
  onDone: () => void | Promise<void>;
  selectedRows: AdminAgentListItem[];
}

/**
 * Selected-count + one 操作 menu, mirroring the users table's right toolbar cluster. Both entries
 * stay visible while a selection exists and go disabled with the reason spelled out, so the
 * operator learns why a row cannot be archived or deleted instead of watching the menu change
 * shape under them.
 */
const AgentListBulkActions = memo<AgentListBulkActionsProps>(
  ({ authMethod, canDelete, onDone, selectedRows }) => {
    const { t } = useTranslation('admin');
    const archivable = useMemo(() => selectArchivableAgents(selectedRows), [selectedRows]);
    const deletable = useMemo(() => selectDeletableAgents(selectedRows), [selectedRows]);

    const items = useMemo<DropdownItem[]>(
      () => [
        {
          danger: true,
          desc: archivable.length === 0 ? t('agentCatalog.bulk.archive.ineligible') : undefined,
          disabled: archivable.length === 0,
          key: 'archive',
          label: t('agentCatalog.bulk.archive.action'),
          onClick: () => openBulkArchiveAgentsModal({ authMethod, onDone, rows: selectedRows, t }),
        },
        {
          danger: true,
          desc: deletable.length === 0 ? t('agentCatalog.bulk.delete.ineligible') : undefined,
          disabled: deletable.length === 0,
          key: 'delete',
          label: t('agentCatalog.bulk.delete.action'),
          onClick: () => openBulkDeleteAgentsModal({ authMethod, onDone, rows: selectedRows, t }),
        },
      ],
      [archivable.length, authMethod, deletable.length, onDone, selectedRows, t],
    );

    // Nothing in this menu is grantable without AGENT_DELETE — a bare count would be dead chrome.
    if (!canDelete || selectedRows.length === 0) return null;

    return (
      <>
        <Text type="secondary">
          {t('agentCatalog.list.selectedCount', { count: selectedRows.length })}
        </Text>
        <DropdownMenu items={items} placement="bottomRight">
          <Button size="small">{t('agentCatalog.list.bulk.actions')}</Button>
        </DropdownMenu>
      </>
    );
  },
);

AgentListBulkActions.displayName = 'AgentListBulkActions';

export default AgentListBulkActions;
