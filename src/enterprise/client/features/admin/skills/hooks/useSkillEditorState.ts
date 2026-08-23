'use client';

import type { confirmModal } from '@lobehub/ui/base-ui';
import { useRef, useState } from 'react';

import type { EditableSkillDraft, SkillRebaseConflict, SkillSaveState } from '../controller';
import type { AdminSkillGetOutput } from '../types';

/**
 * Every piece of editor state in one React-owned cluster, so the hooks around it can be split
 * by concern without any of them owning a slice the others also need.
 */
export const useSkillEditorState = () => {
  const [draft, setDraft] = useState<EditableSkillDraft | null>(null);
  const [baseDraft, setBaseDraft] = useState<EditableSkillDraft | null>(null);
  const [recoveryBaseRevision, setRecoveryBaseRevision] = useState<number>();
  const [recoveryBaseDraftSequence, setRecoveryBaseDraftSequence] = useState<number>();
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<SkillSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [rebaseConflicts, setRebaseConflicts] = useState<SkillRebaseConflict[]>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<AdminSkillGetOutput>();
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const rejectedHydrationKeyRef = useRef<string | null>(null);
  const pendingSnapshotRef = useRef<AdminSkillGetOutput | null>(null);
  const allowedHydrationSkillIdRef = useRef<string | null>(null);
  const pendingNavigationSkillIdRef = useRef<string | null>(null);
  const switchModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  return {
    refs: {
      allowedHydrationSkillIdRef,
      hydratedKeyRef,
      pendingNavigationSkillIdRef,
      pendingSnapshotRef,
      rejectedHydrationKeyRef,
      switchModalRef,
    },
    setters: {
      setActionError,
      setActiveSnapshot,
      setBaseDraft,
      setConflict,
      setDirty,
      setDraft,
      setPendingSwitchId,
      setRebaseConflicts,
      setRecoveryBaseDraftSequence,
      setRecoveryBaseRevision,
      setSaveState,
    },
    state: {
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
    },
  };
};

export type SkillEditorStateStore = ReturnType<typeof useSkillEditorState>;
export type SkillEditorRefs = SkillEditorStateStore['refs'];
export type SkillEditorSetters = SkillEditorStateStore['setters'];
export type SkillEditorStateValues = SkillEditorStateStore['state'];
