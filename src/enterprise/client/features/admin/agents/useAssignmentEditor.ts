'use client';

import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type {
  AdminAgentAssignmentPreviewOutput,
  AdminAgentDetailOutput,
  AdminPlatformAgentAssignmentListOutput,
  AdminPlatformAgentAssignmentUpsertInput,
} from './types';

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

export const useAssignmentEditor = (
  snapshot: AdminAgentDetailOutput,
  mutate: KeyedMutator<AdminAgentDetailOutput>,
  authMethod: AdminReauthAuthMethod | null,
) => {
  const { t } = useTranslation('admin');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [targetType, setTargetTypeState] = useState<TargetType>('global');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<Mode>('optional');
  const [enabled, setEnabled] = useState(true);
  const [versionPolicy, setVersionPolicyState] = useState<VersionPolicy>('latest_published');
  const [pinnedVersionId, setPinnedVersionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AdminAgentAssignmentPreviewOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

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

  const resetForm = () => {
    setEditingId(undefined);
    setTargetTypeState('global');
    setTargetId('');
    setMode('optional');
    setEnabled(true);
    setVersionPolicyState('latest_published');
    setPinnedVersionId(null);
    setPreview(null);
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
    setPreview(null);
    setError(null);
  };

  const setTargetType = (value: TargetType) => {
    setTargetTypeState(value);
    setTargetId(value === 'global' ? '' : '');
    setPreview(null);
  };

  const setVersionPolicy = (value: VersionPolicy) => {
    setVersionPolicyState(value);
    if (value !== 'pinned') setPinnedVersionId(null);
    setPreview(null);
  };

  const previewAssignment = async () => {
    if (validationError) {
      setError(t(validationError as never));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await adminAgentsService.previewAssignment({
          agentId: snapshot.identity.id,
          assignment: draft,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Revalidate after a committed mutation; a refresh failure must never read as a save failure. */
  const syncAfterCommit = async () => {
    try {
      await mutate();
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    }
  };

  const submit = () => {
    if (validationError) {
      setError(t(validationError as never));
      return;
    }
    // Freeze the exact normalized draft + CAS + assignmentId at confirm time.
    const frozenDraft = { ...draft };
    const frozenAssignmentId = editingId;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        agentId: snapshot.identity.id,
        ...frozenDraft,
        ...(frozenAssignmentId ? { assignmentId: frozenAssignmentId } : {}),
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
      }),
      description: t('agentCatalog.assignment.upsertDescription'),
      onSubmit: async (input) => {
        await adminAgentsService.upsertAssignment(input as AdminPlatformAgentAssignmentUpsertInput);
        // Committed: reset the form so the stale CAS cannot be resubmitted, then revalidate.
        resetForm();
        await syncAfterCommit();
        toast.success(t('agentCatalog.assignment.saved'));
      },
      submitLabel: t(
        editingId ? 'agentCatalog.assignment.update' : 'agentCatalog.assignment.create',
      ),
      targetLabel: snapshot.identity.agentKey,
      title: t(
        editingId ? 'agentCatalog.assignment.updateTitle' : 'agentCatalog.assignment.createTitle',
      ),
    });
  };

  const remove = (assignment: Assignment) => {
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        agentId: snapshot.identity.id,
        assignmentId: assignment.id,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
      }),
      danger: true,
      description: t('agentCatalog.assignment.removeDescription'),
      onSubmit: async (input) => {
        await adminAgentsService.removeAssignment(
          input as Parameters<typeof adminAgentsService.removeAssignment>[0],
        );
        if (editingId === assignment.id) resetForm();
        await syncAfterCommit();
        toast.success(t('agentCatalog.assignment.removed'));
      },
      submitLabel: t('agentCatalog.assignment.remove'),
      targetLabel: snapshot.identity.agentKey,
      title: t('agentCatalog.assignment.remove'),
    });
  };

  const retryRefresh = () => void syncAfterCommit();

  return {
    busy,
    draft,
    edit,
    editingId,
    enabled,
    error,
    mode,
    pinnedVersionId,
    preview,
    previewAssignment,
    refreshFailed,
    remove,
    resetForm,
    retryRefresh,
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
