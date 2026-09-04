'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { AgentEditorSaveMeta } from './agentEditorCommitSteps';
import { applyAgentSaveOutputToListItem } from './applySaveOutput';
import type { deriveAdminAgentPermissions } from './controller';
import { getAdminAgentErrorMessage } from './errorPresentation';
import { openAgentEditorModal } from './openAgentEditorModal';
import { openDeleteAgentModal } from './openDeleteAgentModal';
import type { AdminAgentListItem, AdminPlatformAgentSaveOutput } from './types';
import type { AdminAgentRefresh } from './useAdminAgentRefresh';
import { fetchAdminAgentDetail } from './useAdminAgents';

export interface UseAgentListActionsParams {
  agentPermissions: ReturnType<typeof deriveAdminAgentPermissions>;
  authMethod: AdminReauthAuthMethod | null | undefined;
  /** AGENT_UPDATE — an assignment-only operator still opens the editor, read-only. */
  canEditConfig: boolean;
  clearSelection: () => void;
  /** The pinned default's id, once its pointer read has settled. */
  defaultAgentId: string | undefined;
  /** The shared invalidator for both surfaces — never a bare list refresher. */
  refresh: AdminAgentRefresh;
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
  defaultAgentId,
  refresh,
  removeListItem,
  updateListItem,
}: UseAgentListActionsParams) => {
  const { t } = useTranslation('admin');

  /**
   * The committed submit lands on the list. A pure config save can be applied to the one row it
   * changed; a create, or anything that wrote an assignment, changes counters the output does not
   * carry — those revalidate instead of patching a row into a half-truth.
   *
   * The pinned 默认助理 card is a SECOND entry over the same assistant, so a save that touched the
   * default — it IS the pinned one, or this save made it the default — invalidates that key too.
   * Patching only the table row would leave the card showing the name / avatar / model just
   * replaced. `editedAgentId` is what identifies an assignment-only submit, which carries no output.
   */
  const handleSaved = useCallback(
    async (
      output: AdminPlatformAgentSaveOutput | null,
      meta: AgentEditorSaveMeta,
      editedAgentId?: string,
    ) => {
      const savedId = output?.identity.id ?? editedAgentId;
      const touchesDefault =
        Boolean(output?.identity.isDefault) ||
        (savedId !== undefined && savedId === defaultAgentId);
      // Only a pure config save describes its row completely enough to patch in place.
      const listWrite =
        output && !meta.created && !meta.assignmentsChanged
          ? () =>
              updateListItem(output.identity.id, (row) =>
                applyAgentSaveOutputToListItem(output, row),
              )
          : undefined;
      try {
        await (touchesDefault ? refresh.defaultAndList(listWrite) : refresh.listOnly(listWrite));
      } catch {
        // A failed revalidation is reported, never swallowed into a stale row.
        toast.warning(t('agentCatalog.recovery.refreshFailed'));
      }
    },
    [defaultAgentId, refresh, t, updateListItem],
  );

  // List rows carry no draftToken or version config; both row actions load the authoritative
  // aggregate first so a stale row can never author a write against an outdated CAS.
  const openEditorForAgentId = useCallback(
    async (agentId: string) => {
      try {
        const detail = await fetchAdminAgentDetail(agentId, adminAgentsService, false);
        openAgentEditorModal({
          agent: detail,
          authMethod,
          canAssign: agentPermissions.canAssign,
          canEditConfig,
          // The edited id is carried explicitly: an assignments-only submit returns no output, and
          // the pinned card still has to be invalidated when THAT assistant is the default.
          onSaved: (output, meta) => handleSaved(output, meta, agentId),
        });
      } catch (cause) {
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [agentPermissions.canAssign, authMethod, canEditConfig, handleSaved, t],
  );

  const openEditor = useCallback(
    (item: AdminAgentListItem) => openEditorForAgentId(item.identity.id),
    [openEditorForAgentId],
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
          // leave a still-actionable deleted assistant on screen. The pinned key goes with it:
          // a delete can only reach the default behind a successor write, and the card must not
          // keep pointing at an assistant that no longer exists.
          onDeleted: async () => {
            await refresh.defaultAndList(() => removeListItem(detail.identity.id));
          },
        });
      } catch (cause) {
        // Preflight GET failed — never open a delete modal on unknown CAS.
        toast.error(getAdminAgentErrorMessage(cause, t));
      }
    },
    [authMethod, refresh, removeListItem, t],
  );

  /**
   * One revalidation for the whole batch, then the selection is released. A batch archive can
   * retire the outgoing default alongside its successor, so both surfaces are invalidated.
   */
  const handleBulkDone = useCallback(async () => {
    try {
      await refresh.defaultAndList();
    } catch {
      toast.warning(t('agentCatalog.recovery.refreshFailed'));
    }
    clearSelection();
  }, [clearSelection, refresh, t]);

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

  return {
    createAgent,
    handleBulkDone,
    handleSaved,
    openDelete,
    openEditor,
    openEditorForAgentId,
  };
};
