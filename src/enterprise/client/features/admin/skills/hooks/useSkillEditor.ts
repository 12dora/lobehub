'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toEditableSkillDraft } from '../controller';
import type { AdminSkillGetOutput } from '../types';
import { useSkillDraftPersistence } from './useSkillDraftPersistence';
import { useSkillEditorActions } from './useSkillEditorActions';
import { useSkillEditorHydration } from './useSkillEditorHydration';
import { useSkillEditorLeaveGuard } from './useSkillEditorLeaveGuard';
import { useSkillEditorState } from './useSkillEditorState';

export const useSkillEditor = (snapshot: AdminSkillGetOutput | undefined, editable = true) => {
  const { t } = useTranslation('admin');
  const { refs, setters, state } = useSkillEditorState();
  const {
    actionError,
    activeSnapshot,
    baseDraft,
    conflict,
    dirty,
    draft,
    pendingSwitchId,
    rebaseConflicts,
    recoveryBaseDraftSequence,
    recoveryBaseRevision,
    saveState,
  } = state;
  const { switchModalRef } = refs;
  const { markSaved: markPersistenceSaved, status: persistenceStatus } = useSkillDraftPersistence({
    activeId: activeSnapshot?.draft.id,
    baseDraft: baseDraft ?? (activeSnapshot ? toEditableSkillDraft(activeSnapshot) : null),
    baseDraftSequence: recoveryBaseDraftSequence,
    baseRevision: recoveryBaseRevision,
    dirty,
    draft,
    editable,
  });

  useSkillEditorHydration({
    activeSnapshot,
    dirty,
    draft,
    editable,
    persistenceStatus,
    refs,
    setters,
    snapshot,
    t,
  });

  useSkillEditorLeaveGuard({ dirty, editable, refs, t });

  useEffect(
    () => () => {
      switchModalRef.current?.destroy();
      switchModalRef.current = null;
    },
    [switchModalRef],
  );

  const {
    discardLocal,
    markSaved,
    markVersionSaved,
    rebaseLocal,
    resolveRebaseConflict,
    updateIdentity,
    updateVersionDraft,
  } = useSkillEditorActions({
    activeSnapshot,
    baseDraft,
    draft,
    editable,
    markPersistenceSaved,
    rebaseConflicts,
    refs,
    setters,
  });

  return {
    actionError,
    activeSkillId: activeSnapshot?.draft.id ?? null,
    baseDraft,
    conflict,
    dirty,
    discardLocal,
    draft,
    markSaved,
    markVersionSaved,
    pendingSwitchId,
    persistenceStatus,
    rebaseConflicts,
    rebaseLocal,
    resolveRebaseConflict,
    saveState,
    setActionError: setters.setActionError,
    setConflict: setters.setConflict,
    setSaveState: setters.setSaveState,
    updateIdentity,
    updateVersionDraft,
  };
};
