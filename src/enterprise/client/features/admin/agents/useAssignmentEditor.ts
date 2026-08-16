'use client';

import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openDangerConfirm } from '@/enterprise/client/features/admin/primitives/DangerConfirm';
import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import { getAdminAgentErrorMessage } from './errorPresentation';
import type {
  AdminAgentAssignmentPreviewOutput,
  AdminAgentDetailOutput,
  AdminPlatformAgentAssignmentListOutput,
  AdminPlatformAgentAssignmentUpsertInput,
} from './types';
import type { RefreshLock } from './useRefreshLock';

type Assignment = AdminPlatformAgentAssignmentListOutput['items'][number];
type TargetType = AdminPlatformAgentAssignmentUpsertInput['targetType'];
type Mode = AdminPlatformAgentAssignmentUpsertInput['mode'];
type VersionPolicy = AdminPlatformAgentAssignmentUpsertInput['versionPolicy'];

/** The single normalized draft consumed by BOTH preview and the upsert mutation (parity). */
export interface NormalizedAssignmentDraft {
  enabled: boolean;
  mode: Mode;
  pinnedVersionId: string | null;
  targetId: string;
  targetType: TargetType;
  versionPolicy: VersionPolicy;
}

export const normalizeAssignmentDraft = (fields: {
  enabled: boolean;
  mode: Mode;
  pinnedVersionId: string | null;
  targetId: string;
  targetType: TargetType;
  versionPolicy: VersionPolicy;
}): NormalizedAssignmentDraft => ({
  enabled: fields.enabled,
  mode: fields.mode,
  pinnedVersionId: fields.versionPolicy === 'pinned' ? fields.pinnedVersionId : null,
  targetId:
    fields.targetType === 'global' ? PLATFORM_AGENT_GLOBAL_TARGET_ID : fields.targetId.trim(),
  targetType: fields.targetType,
  versionPolicy: fields.versionPolicy,
});

export const validateAssignmentDraft = (draft: NormalizedAssignmentDraft): string | null => {
  if (draft.targetType !== 'global' && !draft.targetId)
    return 'agentCatalog.assignment.errors.targetRequired';
  if (draft.versionPolicy === 'pinned' && !draft.pinnedVersionId)
    return 'agentCatalog.assignment.errors.versionRequired';
  return null;
};

/** Stable fingerprint of the exact normalized draft, used to auto-invalidate a stale preview. */
export const assignmentDraftFingerprint = (draft: NormalizedAssignmentDraft): string =>
  JSON.stringify([
    draft.targetType,
    draft.targetId,
    draft.mode,
    draft.enabled,
    draft.versionPolicy,
    draft.pinnedVersionId,
  ]);

export const useAssignmentEditor = (
  snapshot: AdminAgentDetailOutput,
  authMethod: AdminReauthAuthMethod | null,
  lock: RefreshLock,
) => {
  const { t } = useTranslation('admin');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [targetType, setTargetTypeState] = useState<TargetType>('global');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<Mode>('optional');
  const [enabled, setEnabled] = useState(true);
  const [versionPolicy, setVersionPolicyState] = useState<VersionPolicy>('latest_published');
  const [pinnedVersionId, setPinnedVersionId] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    fingerprint: string;
    result: AdminAgentAssignmentPreviewOutput;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(
    () =>
      normalizeAssignmentDraft({
        enabled,
        mode,
        pinnedVersionId,
        targetId,
        targetType,
        versionPolicy,
      }),
    [enabled, mode, pinnedVersionId, targetId, targetType, versionPolicy],
  );
  const validationError = validateAssignmentDraft(draft);
  const fingerprint = assignmentDraftFingerprint(draft);
  // The preview is shown ONLY while it matches the exact current draft; ANY field change hides it.
  const preview = previewState?.fingerprint === fingerprint ? previewState.result : null;

  const resetForm = () => {
    setEditingId(undefined);
    setTargetTypeState('global');
    setTargetId('');
    setMode('optional');
    setEnabled(true);
    setVersionPolicyState('latest_published');
    setPinnedVersionId(null);
    setPreviewState(null);
    setError(null);
  };

  const edit = (assignment: Assignment) => {
    setEditingId(assignment.id);
    setTargetTypeState(assignment.targetType);
    setTargetId(assignment.targetType === 'global' ? '' : assignment.targetId);
    setMode(assignment.mode);
    setEnabled(assignment.enabled);
    setVersionPolicyState(assignment.versionPolicy);
    setPinnedVersionId(assignment.pinnedVersionId);
    setPreviewState(null);
    setError(null);
  };

  const setTargetType = (value: TargetType) => {
    setTargetTypeState(value);
    setTargetId('');
  };

  const setVersionPolicy = (value: VersionPolicy) => {
    setVersionPolicyState(value);
    if (value !== 'pinned') setPinnedVersionId(null);
  };

  const previewAssignment = async () => {
    if (validationError) {
      setError(t(validationError as never));
      return;
    }
    setBusy(true);
    setError(null);
    // Capture the exact draft this preview is for, so a later edit invalidates the result.
    const requested = { ...draft };
    try {
      const result = await adminAgentsService.previewAssignment({
        agentId: snapshot.identity.id,
        assignment: requested,
      });
      setPreviewState({ fingerprint: assignmentDraftFingerprint(requested), result });
    } catch (cause) {
      setError(getAdminAgentErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    // Locked after a committed change whose refresh failed → block the stale-CAS write.
    if (lock.isLocked()) return;
    if (validationError) {
      setError(t(validationError as never));
      return;
    }
    // Freeze the exact normalized draft + CAS + assignmentId at submit time (identical to preview).
    const payload: AdminPlatformAgentAssignmentUpsertInput = {
      agentId: snapshot.identity.id,
      ...draft,
      ...(editingId ? { assignmentId: editingId } : {}),
      expectedDraftToken: snapshot.draftToken,
      expectedRevision: snapshot.identity.revision,
    };
    const writeToken = {};
    if (!lock.beginWrite(writeToken)) return; // lock BEFORE the service; reject concurrent writes
    setError(null);
    const committed = await runAdminMutation({
      authMethod,
      onError: (cause) => setError(getAdminAgentErrorMessage(cause, t)),
      run: async () => {
        await adminAgentsService.upsertAssignment(payload);
      },
    });
    if (!committed) {
      lock.abortWrite(writeToken);
      return;
    }
    // Committed on the server → mark synchronously before touching local state or refreshing.
    lock.markCommitted(writeToken);
    // Reset the form so the stale CAS cannot be resubmitted, then revalidate.
    resetForm();
    await lock.commitWrite(writeToken);
    toast.success(t('agentCatalog.assignment.saved'));
  };

  const remove = (assignment: Assignment) => {
    if (lock.isLocked()) return;
    const payload = {
      agentId: snapshot.identity.id,
      assignmentId: assignment.id,
      expectedDraftToken: snapshot.draftToken,
      expectedRevision: snapshot.identity.revision,
    };
    openDangerConfirm({
      confirmText: t('agentCatalog.assignment.remove'),
      content: t('agentCatalog.assignment.removeDescription'),
      title: t('agentCatalog.assignment.remove'),
      onConfirm: async () => {
        const writeToken = {};
        if (!lock.beginWrite(writeToken)) return;
        setError(null);
        const committed = await runAdminMutation({
          authMethod,
          onError: (cause) => setError(getAdminAgentErrorMessage(cause, t)),
          run: async () => {
            await adminAgentsService.removeAssignment(payload);
          },
        });
        if (!committed) {
          lock.abortWrite(writeToken);
          return;
        }
        lock.markCommitted(writeToken); // committed on the server → mark before local state / refresh
        if (editingId === assignment.id) resetForm();
        await lock.commitWrite(writeToken);
        toast.success(t('agentCatalog.assignment.removed'));
      },
    });
  };

  return {
    busy,
    draft,
    edit,
    editingId,
    enabled,
    error,
    locked: lock.locked,
    mode,
    pinnedVersionId,
    preview,
    previewAssignment,
    refreshFailed: lock.refreshFailed,
    remove,
    resetForm,
    retryRefresh: lock.retryRefresh,
    setEnabled,
    setMode,
    setPinnedVersionId,
    setTargetId,
    setTargetType,
    setVersionPolicy,
    submit,
    targetId,
    targetType,
    validationError,
    versionPolicy,
  };
};
