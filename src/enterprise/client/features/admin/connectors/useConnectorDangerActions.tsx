'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import {
  CONNECTOR_AUTO_REASON,
  CONNECTOR_ROLLBACK_AUTO_REASON,
} from '@/enterprise/client/features/admin/audit/shared/auditReasonCodes';
import { openDangerConfirm } from '@/enterprise/client/features/admin/primitives/DangerConfirm';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';

import type { AdminConnectorPermissions } from './controller';
import { validateConnectorRollbackTarget } from './controller';
import RollbackRevisionField from './RollbackRevisionField';
import type { AdminConnectorGetOutput, AdminConnectorRollbackInput } from './types';
import { refreshAdminConnectorLists } from './useAdminConnectorCatalog';
import type { useConnectorEditor } from './useConnectorEditor';
import type { ConnectorMutationRunner } from './useConnectorMutationRunner';

/**
 * Stable machine audit reason for rollback, localized at render time. The confirmation stays
 * because it also collects the target revision, but the operator no longer types a reason.
 */
const ROLLBACK_REASON = CONNECTOR_ROLLBACK_AUTO_REASON;

interface UseConnectorDangerActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminConnectorGetOutput;
  editor: ReturnType<typeof useConnectorEditor>;
  permissions: AdminConnectorPermissions;
  runner: ConnectorMutationRunner;
}

/**
 * The connector actions that destroy or roll back operator-visible state, each gated by its own
 * confirmation. Grouped away from the save/test/publish path because they share the same shape:
 * guard → modal → audited mutation.
 */
export const useConnectorDangerActions = ({
  authMethod,
  data,
  editor,
  permissions,
  runner,
}: UseConnectorDangerActionsParams) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { busyAction, errorText, run, runSimple, setBusyAction } = runner;

  const archive = useCallback(() => {
    if (!permissions.canArchive || editor.dirty || editor.conflict || busyAction) return;
    openDangerConfirm({
      confirmText: t('connectorCatalog.actions.archive'),
      content: t('connectorCatalog.mutations.archive.description'),
      title: t('connectorCatalog.mutations.archive.title'),
      onConfirm: () =>
        runSimple({
          action: 'archive',
          operation: () =>
            adminConnectorsService.archive({
              expectedDraftToken: data.draftToken,
              expectedRevision: data.baseRevision,
              id: data.draft.id,
            }),
          permission: permissions.canArchive,
          successKey: 'connectorCatalog.toast.archived',
        }),
    });
  }, [busyAction, data, editor.conflict, editor.dirty, permissions.canArchive, runSimple, t]);

  /**
   * Revoking every user's connection is destructive and irreversible for them, so the modal (and
   * its impact copy) stays — but the operator confirms rather than justifies; the audit row keeps
   * a stable machine reason.
   */
  const revokeBindings = useCallback(() => {
    if (
      !permissions.canRevokeBindings ||
      !data.published ||
      editor.dirty ||
      editor.conflict ||
      busyAction
    ) {
      return;
    }
    const publishedRevision = data.published.publishedRevision;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      autoReason: CONNECTOR_AUTO_REASON.revokeAllBindings,
      buildPayload: (reason) => ({ reason }),
      danger: true,
      description: t('connectorCatalog.mutations.revoke.description'),
      hideReason: true,
      onSubmit: async (input) => {
        await run(
          'revoke',
          () =>
            adminConnectorsService.revokeAllBindings({
              expectedRevision: publishedRevision,
              id: data.draft.id,
              reason: (input as { reason: string }).reason,
            }),
          'connectorCatalog.toast.revoked',
        );
      },
      submitLabel: t('connectorCatalog.actions.revokeBindings'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.revoke.title'),
    });
  }, [
    authMethod,
    busyAction,
    data.draft.displayName,
    data.draft.id,
    data.published,
    editor.conflict,
    editor.dirty,
    permissions.canRevokeBindings,
    run,
    t,
  ]);

  const rollback = useCallback(() => {
    const currentRevision = data.published?.publishedRevision;
    if (
      !permissions.canPublish ||
      !currentRevision ||
      editor.dirty ||
      editor.conflict ||
      busyAction
    ) {
      return;
    }
    const targetRevisionRef: { current: number | null } = { current: null };
    openReasonModal({
      authMethod: authMethod ?? undefined,
      autoReason: ROLLBACK_REASON,
      buildPayload: (reason) => ({
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        reason,
        targetRevision: targetRevisionRef.current,
      }),
      danger: true,
      description: t('connectorCatalog.mutations.rollback.description'),
      hideReason: true,
      extra: ({ locked }) => (
        <RollbackRevisionField
          currentRevision={currentRevision}
          disabled={locked}
          onChange={(value) => {
            targetRevisionRef.current = value;
          }}
        />
      ),
      onSubmit: async (input) => {
        await run(
          'rollback',
          () => adminConnectorsService.rollback(input as AdminConnectorRollbackInput),
          'connectorCatalog.toast.rolledBack',
        );
      },
      submitLabel: t('connectorCatalog.actions.rollback'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.rollback.title'),
      validateExtra: () => {
        const error = validateConnectorRollbackTarget(targetRevisionRef.current, currentRevision);
        return error ? `connectorCatalog.mutations.rollback.validation.${error}` : null;
      },
    });
  }, [authMethod, busyAction, data, editor.conflict, editor.dirty, permissions.canPublish, run, t]);

  const deleteDraft = useCallback(() => {
    if (!permissions.canDelete || data.published || editor.dirty || editor.conflict || busyAction)
      return;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      autoReason: CONNECTOR_AUTO_REASON.deleteDraft,
      buildPayload: (reason) => ({ id: data.draft.id, reason }),
      danger: true,
      description: t('connectorCatalog.mutations.delete.description'),
      hideReason: true,
      onSubmit: async (input) => {
        setBusyAction('delete');
        try {
          await adminConnectorsService.deleteDraft({
            ...(input as { id: string; reason: string }),
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
          });
          // Delete committed: navigate and toast even if list revalidation fails.
          toast.success(t('connectorCatalog.toast.deleted'));
          navigate('/admin/connectors');
          await Promise.allSettled([refreshAdminConnectorLists()]);
        } catch (cause) {
          editor.setActionError(errorText(cause));
          throw cause;
        } finally {
          setBusyAction(null);
        }
      },
      submitLabel: t('connectorCatalog.actions.deleteDraft'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.delete.title'),
    });
  }, [
    authMethod,
    busyAction,
    data,
    editor,
    errorText,
    navigate,
    permissions.canDelete,
    setBusyAction,
    t,
  ]);

  return { archive, deleteDraft, revokeBindings, rollback };
};
