'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import { applyAgentSaveOutputToListItem } from './applySaveOutput';
import type { deriveAdminAgentPermissions } from './controller';
import { getAdminAgentErrorMessage } from './errorPresentation';
import type { AgentEditorModalProps } from './openAgentEditorModal';
import { openAgentEditorModal } from './openAgentEditorModal';
import { openDeleteAgentModal } from './openDeleteAgentModal';
import type { AdminAgentListItem } from './types';
import { fetchAdminAgentDetail } from './useAdminAgents';

export interface UseAgentListActionsParams {
  agentPermissions: ReturnType<typeof deriveAdminAgentPermissions>;
  authMethod: AdminReauthAuthMethod | null | undefined;
  /** AGENT_UPDATE — an assignment-only operator still opens the editor, read-only. */
  canEditConfig: boolean;
  clearSelection: () => void;
  refreshList: () => Promise<unknown>;
  removeListItem: (id: string) => Promise<unknown>;
  updateListItem: (
    id: string,
    patch: (row: AdminAgentListItem) => AdminAgentListItem,
  ) => Promise<unknown>;
}

/**
 * Everything the list page does to a row. Each action loads the authoritative aggregate before it
 * opens a modal, so a stale row can never author a write against an outdated CAS.
 */
export const useAgentListActions = ({
  agentPermissions,
  authMethod,
  canEditConfig,
  clearSelection,
  refreshList,
  removeListItem,
  updateListItem,
}: UseAgentListActionsParams) => {
  const { t } = useTranslation('admin');

  /**
   * The committed submit lands on the list. A pure config save can be applied to the one row it
   * changed; a create, or anything that wrote an assignment, changes counters the output does not
   * carry — those revalidate instead of patching a row into a half-truth.
   */
  const handleSaved = useCallback<NonNullable<AgentEditorModalProps['onSaved']>>(
    async (output, meta) => {
      try {
        if (output && !meta.created && !meta.assignmentsChanged) {
          await updateListItem(output.identity.id, (row) =>
            applyAgentSaveOutputToListItem(output, row),
          );
        } else {
          await refreshList();
        }
      } catch {
        // A failed revalidation is reported, never swallowed into a stale row.
        toast.warning(t('agentCatalog.recovery.refreshFailed'));
      }
    },
    [refreshList, t, updateListItem],
  );

  // List rows carry no draftToken or version config; both row actions load the authoritative
  // aggregate first so a stale row can never author a write against an outdated CAS.
  const openEditor = useCallback(
    async (item: AdminAgentListItem) => {
      try {
        const detail = await fetchAdminAgentDetail(item.identity.id, adminAgentsService, false);
        openAgentEditorModal({
          agent: detail,
          authMethod,
          canAssign: agentPermissions.canAssign,
          canEditConfig,
          onSaved: handleSaved,
        });
      } catch (cause) {
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [agentPermissions.canAssign, authMethod, canEditConfig, handleSaved, t],
  );

  const openDelete = useCallback(
    async (item: AdminAgentListItem) => {
      try {
        const detail = await adminAgentsService.get({ id: item.identity.id });
        openDeleteAgentModal({
          agentId: detail.identity.id,
          authMethod: authMethod ?? undefined,
          displayName: item.displayName,
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.identity.revision,
          // Drop the committed row from bound infinite pages first so a failed refresh cannot
          // leave a still-actionable deleted assistant on screen.
          onDeleted: async () => {
            await removeListItem(detail.identity.id);
          },
        });
      } catch (cause) {
        // Preflight GET failed — never open a delete modal on unknown CAS.
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [authMethod, removeListItem, t],
  );

  /** One revalidation for the whole batch, then the selection is released. */
  const handleBulkDone = useCallback(async () => {
    try {
      await refreshList();
    } catch {
      toast.warning(t('agentCatalog.recovery.refreshFailed'));
    }
    clearSelection();
  }, [clearSelection, refreshList, t]);

  /** Opened from the page header: a create has no aggregate to preload. */
  const createAgent = useCallback(
    () =>
      openAgentEditorModal({
        authMethod,
        canAssign: agentPermissions.canAssign,
        // Coherent with delete: revalidate the infinite list via the bound mutate so the assistant
        // that is now live appears in place. There is no detail page to navigate into any more.
        onSaved: handleSaved,
      }),
    [agentPermissions.canAssign, authMethod, handleSaved],
  );

  return { createAgent, handleBulkDone, handleSaved, openDelete, openEditor };
};
