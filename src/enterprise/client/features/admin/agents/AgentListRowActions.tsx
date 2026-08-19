'use client';

import { Flexbox } from '@lobehub/ui';
import { Button, type DropdownItem, DropdownMenu } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { deriveAdminAgentActionAvailability, deriveAdminAgentPermissions } from './controller';
import type { AdminAgentListItem } from './types';
import type { useAgentRowActions } from './useAgentRowActions';

export interface AgentListRowActionsProps {
  agentPermissions: ReturnType<typeof deriveAdminAgentPermissions>;
  availability: ReturnType<typeof deriveAdminAgentActionAvailability>;
  canOpenEditor: boolean;
  item: AdminAgentListItem;
  openDelete: (item: AdminAgentListItem) => void;
  openEditor: (item: AdminAgentListItem) => void;
  rowActions: Pick<ReturnType<typeof useAgentRowActions>, 'archive' | 'setDefaultInbox'>;
}

export const AgentListRowActions = memo<AgentListRowActionsProps>(
  ({ agentPermissions, availability, canOpenEditor, item, openDelete, openEditor, rowActions }) => {
    const { t } = useTranslation('admin');
    // Default / system assistants cannot be hard-deleted (server refuses too).
    const deletable = !item.identity.isDefault && item.identity.systemKey === null;
    // Archiving an already-archived assistant is a no-op the server rejects.
    const archivable = item.identity.status === 'published';
    // A published row always has a current version (the DB pointer check guarantees
    // it), which is exactly what the detail page's `canSetDefaultNow` required.
    const promotable = agentPermissions.canPublish && archivable && !item.identity.isDefault;
    // Both destructive lifecycle actions live behind 更多 so the row keeps three
    // controls at most; the everyday ones stay one click away.
    const moreActions: DropdownItem[] = [
      ...(availability.canArchiveNow && archivable
        ? [
            {
              danger: true,
              key: 'archive',
              label: t('agentCatalog.archive.submit'),
              onClick: () => void rowActions.archive(item),
            },
          ]
        : []),
      ...(agentPermissions.canDelete && deletable
        ? [
            {
              danger: true,
              key: 'delete',
              label: t('agentCatalog.delete.action'),
              onClick: () => void openDelete(item),
            },
          ]
        : []),
    ];

    return (
      <Flexbox horizontal gap={4} onClick={(event) => event.stopPropagation()}>
        {canOpenEditor ? (
          <Button size="small" type="text" onClick={() => void openEditor(item)}>
            {/* An assignment-only operator opens the SAME modal, config read-only. */}
            {t(availability.canEdit ? 'agentCatalog.action.edit' : 'agentCatalog.action.assign')}
          </Button>
        ) : null}
        {/* Promoting an assistant that already IS the default says nothing — hide it. */}
        {promotable ? (
          <Button size="small" type="text" onClick={() => void rowActions.setDefaultInbox(item)}>
            {t('agentCatalog.defaultSwitch.action')}
          </Button>
        ) : null}
        {moreActions.length > 0 ? (
          <DropdownMenu items={moreActions} placement="bottomRight">
            <Button aria-label={t('agentCatalog.list.more')} size="small" type="text">
              {t('agentCatalog.list.more')}
            </Button>
          </DropdownMenu>
        ) : null}
      </Flexbox>
    );
  },
);

AgentListRowActions.displayName = 'AgentListRowActions';
