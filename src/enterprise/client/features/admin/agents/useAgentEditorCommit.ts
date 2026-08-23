'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AgentCommitProgress, AgentEditorSavedHandler } from './agentEditorCommitSteps';
import {
  announceAgentCommit,
  announceAgentCommitFailure,
  planAgentCommit,
  runAgentCommitChain,
} from './agentEditorCommitSteps';
import type { AgentEditorCas } from './agentEditorSubmit';
import { reconcileAgentAfterFailure } from './agentEditorSubmit';
import { seedAgentEditorValue } from './agentEditorValue';
import type { AssignmentPlan } from './assignmentDraft';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import type { AgentAssignmentDraft } from './useAgentAssignmentDraft';
import type { AgentEditorDraft } from './useAgentEditorDraft';

/** Nothing to write: an operator without AGENT_ASSIGN never authors a distribution change. */
const NO_ASSIGNMENT_PLAN: AssignmentPlan = { removals: [], upserts: [] };

/**
 * What the LAST submit left on screen, plus whether the current input still counts as unsaved.
 * Every authoring edit retires all three at once, which is why the draft is handed `markChanged`.
 */
export const useAgentEditorOutcome = () => {
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Set once the write commits: the form value still differs from the seed baseline, but it is no
  // longer unsaved, so the close guard must not challenge it.
  const committedRef = useRef(false);

  const markChanged = useCallback(() => {
    committedRef.current = false;
    setError(null);
    setConflict(false);
  }, []);

  return { committedRef, conflict, error, markChanged, setConflict, setError };
};

export type AgentEditorOutcome = ReturnType<typeof useAgentEditorOutcome>;

export interface UseAgentEditorCommitParams {
  agent?: AdminAgentDetailOutput;
  assignments: AgentAssignmentDraft;
  authMethod?: AdminReauthAuthMethod | null;
  canAssign: boolean;
  configEditable: boolean;
  dirtyRef?: { current: boolean };
  draft: AgentEditorDraft;
  isCreate: boolean;
  onClose?: () => void;
  onSaved?: AgentEditorSavedHandler;
  outcome: AgentEditorOutcome;
  pendingRef?: { current: boolean };
}

/**
 * The write side of the editor: what is still unsaved, what the next write must echo back, and the
 * submit chain itself — prepare, commit, then announce whichever outcome the server gave us.
 */
export const useAgentEditorCommit = ({
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
}: UseAgentEditorCommitParams) => {
  const { t } = useTranslation('admin');
  const [saving, setSaving] = useState(false);
  /**
   * Set when a rejected write may still have committed AND the reconcile read could not tell us.
   * Retrying blind could create a second assistant, so Save stays closed until the modal is
   * reopened against a fresh read.
   */
  const [resumeBlocked, setResumeBlocked] = useState(false);
  /**
   * The CAS the NEXT write must echo. It starts at the loaded aggregate and advances after every
   * committed write, so a submit whose assignment chain failed half-way can be retried from the
   * modal without a conflict — and without replaying the writes that already landed.
   */
  const [identity, setIdentity] = useState<AgentEditorCas | null>(() =>
    agent
      ? {
          agentId: agent.identity.id,
          draftToken: agent.draftToken,
          revision: agent.identity.revision,
        }
      : null,
  );
  /** The version output of the last committed save/create, replayed to `onSaved` on a retry. */
  const [lastOutput, setLastOutput] = useState<AdminPlatformAgentSaveOutput | null>(null);
  /** Fingerprint of the value at the last committed save — what "already saved" means now. */
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);

  const { agentKey, baselineFingerprint, keyValid, value, valueFingerprint } = draft;
  const { committedRef, setConflict, setError } = outcome;

  // A read-only config can never be dirty, so it can never schedule a version write.
  const configDirty =
    configEditable &&
    (valueFingerprint !== (savedFingerprint ?? baselineFingerprint) ||
      (isCreate && !identity && agentKey.trim().length > 0));
  const dirty = configDirty || assignments.dirty;
  // NOT cleared while saving: a write can still fail, and the input would then be unsaved again.
  // The in-flight window is covered by `pendingRef`, which vetoes dismissal outright.
  if (dirtyRef) dirtyRef.current = dirty && !committedRef.current;

  /**
   * Ask the server what actually landed after an ambiguous failure, and re-base every piece of
   * resume state on the answer: the CAS, the assignment baseline, and whether the config we tried
   * to write is already live.
   *
   * Returns `'found'` when the assistant exists (state has been re-based), `'absent'` when the
   * create provably never happened, and `'unknown'` when we could not tell — the one case where
   * retrying could create a second assistant, so the caller must refuse to resume.
   */
  const reconcile = useCallback(
    async (agentId: string | undefined) =>
      reconcileAgentAfterFailure({
        agentId,
        agentKey: agentKey.trim(),
        onFound: (fresh) => {
          setIdentity({
            agentId: fresh.identity.id,
            draftToken: fresh.draftToken,
            revision: fresh.identity.revision,
          });
          assignments.reconcile(fresh.assignments);
          // Only claim the config is saved when the LIVE version really matches what we tried to
          // write; otherwise the next Save must author it again.
          const live = JSON.stringify(seedAgentEditorValue(fresh));
          setSavedFingerprint(live === valueFingerprint ? valueFingerprint : null);
        },
      }),
    [agentKey, assignments, valueFingerprint],
  );

  const submit = useCallback(async () => {
    if (saving || resumeBlocked) return;
    const commitPlan = planAgentCommit({
      configDirty,
      configEditable,
      hasIdentity: Boolean(identity),
      keyValid,
      value,
    });
    if (!commitPlan.valid) {
      setError(t('agentCatalog.save.invalid'));
      return;
    }
    setSaving(true);
    if (pendingRef) pendingRef.current = true; // veto every dismissal until this write settles
    setError(null);
    setConflict(false);
    // Frozen for the whole chain: the plan the operator saw when they pressed Save.
    const plan = canAssign ? assignments.plan : NO_ASSIGNMENT_PLAN;
    const meta = {
      assignmentsChanged: plan.removals.length > 0 || plan.upserts.length > 0,
      created: !identity,
    };
    const progress: AgentCommitProgress = {
      cas: identity,
      identityCommitted: false,
      output: lastOutput,
    };
    try {
      await runAgentCommitChain(progress, {
        agentKey,
        authMethod: authMethod ?? null,
        commitPlan,
        onAssignmentRemoved: assignments.markRemoved,
        onAssignmentUpserted: assignments.markUpserted,
        onCas: setIdentity,
        onVersionWritten: (cas, output) => {
          setIdentity(cas);
          setLastOutput(output);
          setSavedFingerprint(valueFingerprint);
        },
        plan,
      });
      // Everything committed: the input is no longer unsaved and no write can still fail, so both
      // guards are released before the (slower) cache apply + revalidate.
      committedRef.current = true;
      if (dirtyRef) dirtyRef.current = false;
      if (pendingRef) pendingRef.current = false;
      await announceAgentCommit({ meta, onClose, onSaved, output: progress.output, t });
    } catch (cause) {
      await announceAgentCommitFailure({
        cause,
        created: meta.created,
        onSaved,
        progress,
        reconcile,
        setConflict,
        setError,
        setResumeBlocked,
        t,
      });
    } finally {
      setSaving(false);
      if (pendingRef) pendingRef.current = false;
    }
  }, [
    agentKey,
    assignments,
    authMethod,
    canAssign,
    committedRef,
    configDirty,
    configEditable,
    dirtyRef,
    identity,
    keyValid,
    lastOutput,
    onClose,
    onSaved,
    pendingRef,
    reconcile,
    resumeBlocked,
    saving,
    setConflict,
    setError,
    t,
    value,
    valueFingerprint,
  ]);

  return {
    /** The config differs from what is committed — this submit will author a version. */
    configDirty,
    dirty,
    /** False for a create that has not committed anything yet. */
    hasIdentity: Boolean(identity),
    resumeBlocked,
    saving,
    submit,
  };
};
