'use client';

import { useCallback } from 'react';

import {
  type EditableSkillDraft,
  type EditableSkillIdentityDraft,
  type EditableSkillVersionDraft,
  isSkillIdentityDirty,
  rebaseSkillDraft,
  type SkillRebaseConflict,
  toEditableSkillDraft,
} from '../controller';
import { clearSkillLocalDraft } from '../localDraftStorage';
import type { AdminSkillGetOutput } from '../types';
import { applyPristineSkillState, hydrationKeyOf } from './skillEditorState';
import type { SkillEditorRefs, SkillEditorSetters } from './useSkillEditorState';

interface SkillEditorActionsInput {
  activeSnapshot: AdminSkillGetOutput | undefined;
  baseDraft: EditableSkillDraft | null;
  draft: EditableSkillDraft | null;
  editable: boolean;
  markPersistenceSaved: () => void;
  rebaseConflicts: SkillRebaseConflict[];
  refs: SkillEditorRefs;
  setters: SkillEditorSetters;
}

/** Everything the editor UI can do to the draft, once a snapshot is standing. */
export const useSkillEditorActions = ({
  activeSnapshot,
  baseDraft,
  draft,
  editable,
  markPersistenceSaved,
  rebaseConflicts,
  refs,
  setters,
}: SkillEditorActionsInput) => {
  const { hydratedKeyRef } = refs;
  const {
    setActionError,
    setActiveSnapshot,
    setBaseDraft,
    setConflict,
    setDirty,
    setDraft,
    setRebaseConflicts,
    setRecoveryBaseDraftSequence,
    setRecoveryBaseRevision,
    setSaveState,
  } = setters;

  const updateIdentity = useCallback(
    <Key extends keyof EditableSkillIdentityDraft>(
      key: Key,
      value: EditableSkillIdentityDraft[Key],
    ) => {
      if (!editable) return;
      setDraft((current) =>
        current ? { ...current, identity: { ...current.identity, [key]: value } } : current,
      );
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable, setActionError, setDirty, setDraft, setSaveState],
  );

  const updateVersionDraft = useCallback(
    (versionDraft: EditableSkillVersionDraft | null) => {
      if (!editable) return;
      setDraft((current) => (current ? { ...current, versionDraft } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable, setActionError, setDirty, setDraft, setSaveState],
  );

  const discardLocal = useCallback(() => {
    if (!activeSnapshot) return;
    clearSkillLocalDraft(activeSnapshot.draft.id);
    applyPristineSkillState(
      {
        setActionError,
        setBaseDraft,
        setConflict,
        setDirty,
        setDraft,
        setRecoveryBaseDraftSequence,
        setRecoveryBaseRevision,
        setSaveState,
      },
      {
        baseDraftSequence: activeSnapshot.draft.draftSequence,
        baseRevision: activeSnapshot.baseRevision,
        latest: toEditableSkillDraft(activeSnapshot),
      },
    );
    markPersistenceSaved();
    setRebaseConflicts([]);
  }, [
    activeSnapshot,
    markPersistenceSaved,
    setActionError,
    setBaseDraft,
    setConflict,
    setDirty,
    setDraft,
    setRebaseConflicts,
    setRecoveryBaseDraftSequence,
    setRecoveryBaseRevision,
    setSaveState,
  ]);

  const rebaseLocal = useCallback(
    (latestSnapshot?: AdminSkillGetOutput) => {
      const source = latestSnapshot ?? activeSnapshot;
      if (!source || !draft || !baseDraft) return;
      const latest = toEditableSkillDraft(source);
      const result = rebaseSkillDraft({ latest, local: draft, original: baseDraft });
      setBaseDraft(latest);
      setRecoveryBaseRevision(source.baseRevision);
      setRecoveryBaseDraftSequence(source.draft.draftSequence);
      setDraft(result.draft);
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setRebaseConflicts(result.conflicts);
      setConflict(result.conflicts.length > 0);
      setActiveSnapshot(source);
      hydratedKeyRef.current = hydrationKeyOf(source, editable);
    },
    [
      activeSnapshot,
      baseDraft,
      draft,
      editable,
      hydratedKeyRef,
      setActionError,
      setActiveSnapshot,
      setBaseDraft,
      setConflict,
      setDirty,
      setDraft,
      setRebaseConflicts,
      setRecoveryBaseDraftSequence,
      setRecoveryBaseRevision,
      setSaveState,
    ],
  );

  const resolveRebaseConflict = useCallback(
    (field: keyof EditableSkillIdentityDraft, choice: 'latest' | 'local') => {
      const conflictItem = rebaseConflicts.find((item) => item.field === field);
      if (!conflictItem) return;
      setDraft((current) =>
        current
          ? {
              ...current,
              identity: {
                ...current.identity,
                [field]: structuredClone(conflictItem[choice]),
              },
            }
          : current,
      );
      setRebaseConflicts((current) => {
        const next = current.filter((item) => item.field !== field);
        if (next.length === 0) setConflict(false);
        return next;
      });
      setDirty(true);
      setSaveState('dirty');
    },
    [rebaseConflicts, setConflict, setDirty, setDraft, setRebaseConflicts, setSaveState],
  );

  const markSaved = useCallback(() => {
    if (!activeSnapshot) return;
    clearSkillLocalDraft(activeSnapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    markPersistenceSaved();
    setRebaseConflicts([]);
  }, [
    activeSnapshot,
    markPersistenceSaved,
    setActionError,
    setConflict,
    setDirty,
    setRebaseConflicts,
    setSaveState,
  ]);

  const markVersionSaved = useCallback(() => {
    if (!activeSnapshot) return;
    const identityDirty = isSkillIdentityDirty(draft, baseDraft);
    setDraft((current) => (current ? { ...current, versionDraft: null } : current));
    setDirty(identityDirty);
    setConflict(false);
    setSaveState(identityDirty ? 'dirty' : 'saved');
    setActionError(null);
    setRebaseConflicts([]);
    if (!identityDirty) {
      clearSkillLocalDraft(activeSnapshot.draft.id);
      markPersistenceSaved();
    }
  }, [
    activeSnapshot,
    baseDraft,
    draft,
    markPersistenceSaved,
    setActionError,
    setConflict,
    setDirty,
    setDraft,
    setRebaseConflicts,
    setSaveState,
  ]);

  return {
    discardLocal,
    markSaved,
    markVersionSaved,
    rebaseLocal,
    resolveRebaseConflict,
    updateIdentity,
    updateVersionDraft,
  };
};
