'use client';

import { useMemo } from 'react';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AgentEditorSaveMeta } from './agentEditorCommitSteps';
import { isCurrentAgentVersionMissing } from './agentEditorValue';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import { useAgentAssignmentDraft } from './useAgentAssignmentDraft';
import { useAgentEditorCommit, useAgentEditorOutcome } from './useAgentEditorCommit';
import { useAgentEditorDraft } from './useAgentEditorDraft';

export type { AgentEditorSaveMeta };
export {
  AGENT_KEY_MAX_LENGTH,
  buildAgentConfig,
  createFallbackAgentKey,
  isAgentKeyValid,
  isCurrentAgentVersionMissing,
  normalizeList,
  seedAgentEditorValue,
  suggestAgentKey,
} from './agentEditorValue';

export interface UseAgentEditorFormParams {
  /** Present → edit an existing assistant; absent → create a new one. */
  agent?: AdminAgentDetailOutput;
  authMethod?: AdminReauthAuthMethod | null;
  /** AGENT_ASSIGN: without it the assignment section is hidden and never written. */
  canAssign?: boolean;
  /**
   * AGENT_UPDATE + AGENT_PUBLISH. Without it the config is read-only and no version is ever
   * written — an assignment-only operator still opens this modal to edit 分配策略.
   */
  canEditConfig?: boolean;
  /** Shared with the modal opener so a user-initiated close can confirm unsaved input. */
  dirtyRef?: { current: boolean };
  /** Close the hosting modal after a successful save. */
  onClose?: () => void;
  /**
   * Apply the committed output to the caches the caller owns and revalidate. A rejection means the
   * caller did NOT handle the failure, and the editor surfaces the refresh-failed warning itself.
   * `output` is null when only assignments changed — there was no new version to apply.
   */
  onSaved?: (
    output: AdminPlatformAgentSaveOutput | null,
    meta: AgentEditorSaveMeta,
  ) => Promise<void> | void;
  /**
   * Shared with the modal opener: true from the moment the write leaves the client until it
   * commits (or fails). While it is set, EVERY passive dismissal is vetoed — a modal that closes
   * mid-write would strand the admin with no idea whether the assistant changed.
   */
  pendingRef?: { current: boolean };
}

/**
 * The assistant editor modal, composed of three cohesive units: the outcome the last submit left
 * on screen, the draft the admin is editing, and the commit chain that writes it.
 */
export const useAgentEditorForm = ({
  agent,
  authMethod,
  canAssign = false,
  canEditConfig = true,
  dirtyRef,
  onClose,
  onSaved,
  pendingRef,
}: UseAgentEditorFormParams) => {
  const isCreate = !agent;
  const outcome = useAgentEditorOutcome();
  const draft = useAgentEditorDraft({ agent, isCreate, onChanged: outcome.markChanged });
  // A truncated assignment page cannot be diffed safely — the section renders read-only instead.
  const assignmentsTruncated = Boolean(agent?.collectionMeta?.assignmentsTruncated);
  const assignments = useAgentAssignmentDraft(canAssign ? agent?.assignments : undefined, {
    truncated: assignmentsTruncated,
  });
  // The published pointer is not among the loaded versions: nothing here may author a version.
  const currentVersionMissing = useMemo(() => isCurrentAgentVersionMissing(agent), [agent]);
  const configEditable = canEditConfig && !currentVersionMissing;

  const commit = useAgentEditorCommit({
    agent,
    assignments,
    authMethod,
    canAssign,
    configEditable,
    dirtyRef,
    draft,
    isCreate,
    onClose,
    onSaved,
    outcome,
    pendingRef,
  });

  // An assignment-only operator never writes a version, so the config requirements (a valid
  // config, a resolved model catalog, a legal key) are not theirs to satisfy.
  const configReady =
    !configEditable || (Boolean(draft.config) && draft.keyValid && draft.depValidity.ready);
  // `!identity` covers create before its first commit; once anything committed, Save needs a change.
  const canSubmit =
    !commit.saving &&
    !commit.resumeBlocked &&
    configReady &&
    (commit.dirty || (configEditable && !commit.hasIdentity));

  return {
    agentKey: draft.agentKey,
    /** The 分配策略 editor state; only meaningful when `canAssign` is true. */
    assignments,
    canAssign,
    /** False for an assignment-only operator, or when the live version could not be loaded. */
    configEditable,
    /** The published pointer version is not in the loaded page — the config must not be authored. */
    currentVersionMissing,
    canSubmit,
    changeAgentKey: draft.changeAgentKey,
    conflict: outcome.conflict,
    depValidity: draft.depValidity,
    dirty: commit.dirty,
    error: outcome.error,
    isCreate,
    keyValid: draft.keyValid,
    missingRequirements: draft.missingRequirements,
    patchConfig: draft.patchConfig,
    saving: commit.saving,
    setDependencies: draft.setDependencies,
    setDepValidity: draft.setDepValidity,
    setDisplayName: draft.setDisplayName,
    submit: commit.submit,
    /** A rejected write may have committed and we could not tell — Save is closed until reopened. */
    resumeBlocked: commit.resumeBlocked,
    /** `default-inbox` for the platform's built-in assistant, which every member already gets. */
    systemKey: agent?.identity.systemKey ?? null,
    value: draft.value,
  };
};
