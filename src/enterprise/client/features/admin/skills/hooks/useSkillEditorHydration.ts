'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect } from 'react';

import {
  type EditableSkillDraft,
  fingerprintSkillDraft,
  toEditableSkillDraft,
} from '../controller';
import { loadSkillLocalDraft, type SkillDraftPersistenceStatus } from '../localDraftStorage';
import { decideSkillHydration } from '../skillHydration';
import type { AdminSkillGetOutput } from '../types';
import {
  applyPristineSkillState,
  applyRecoveredSkillState,
  hydrationKeyOf,
  isStaleLocalBase,
} from './skillEditorState';
import type { SkillEditorRefs, SkillEditorSetters } from './useSkillEditorState';

interface SkillEditorHydrationInput {
  activeSnapshot: AdminSkillGetOutput | undefined;
  dirty: boolean;
  draft: EditableSkillDraft | null;
  editable: boolean;
  persistenceStatus: SkillDraftPersistenceStatus;
  refs: SkillEditorRefs;
  setters: SkillEditorSetters;
  snapshot: AdminSkillGetOutput | undefined;
  t: TFunction<'admin'>;
}

/**
 * Owns which server row the editor is standing on: installing one, recovering the local draft
 * over it, and asking before an unsaved draft would be replaced by another Skill.
 */
export const useSkillEditorHydration = ({
  activeSnapshot,
  dirty,
  draft,
  editable,
  persistenceStatus,
  refs,
  setters,
  snapshot,
  t,
}: SkillEditorHydrationInput) => {
  const {
    allowedHydrationSkillIdRef,
    hydratedKeyRef,
    pendingSnapshotRef,
    rejectedHydrationKeyRef,
    switchModalRef,
  } = refs;
  const {
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
  } = setters;

  const hydrateSnapshot = useCallback(
    (nextSnapshot: AdminSkillGetOutput) => {
      hydratedKeyRef.current = hydrationKeyOf(nextSnapshot, editable);
      rejectedHydrationKeyRef.current = null;
      pendingSnapshotRef.current = null;
      setPendingSwitchId(null);
      setActiveSnapshot(nextSnapshot);

      const draftSetters = {
        setActionError,
        setBaseDraft,
        setConflict,
        setDirty,
        setDraft,
        setRecoveryBaseDraftSequence,
        setRecoveryBaseRevision,
        setSaveState,
      };
      const latest = toEditableSkillDraft(nextSnapshot);
      const local = editable ? loadSkillLocalDraft(nextSnapshot.draft.id) : null;
      if (local) {
        applyRecoveredSkillState(draftSetters, {
          local,
          staleBase: isStaleLocalBase(local, nextSnapshot, latest),
        });
        setRebaseConflicts([]);
        return;
      }

      applyPristineSkillState(draftSetters, {
        baseDraftSequence: nextSnapshot.draft.draftSequence,
        baseRevision: nextSnapshot.baseRevision,
        latest,
      });
      setRebaseConflicts([]);
    },
    [
      editable,
      hydratedKeyRef,
      pendingSnapshotRef,
      rejectedHydrationKeyRef,
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
    ],
  );

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = hydrationKeyOf(snapshot, editable);
    const storedCurrent =
      dirty && activeSnapshot && draft && persistenceStatus === 'saved'
        ? loadSkillLocalDraft(activeSnapshot.draft.id)
        : null;
    const hasSafeRecovery = Boolean(
      storedCurrent &&
      draft &&
      fingerprintSkillDraft(storedCurrent.draft) === fingerprintSkillDraft(draft),
    );
    const decision = decideSkillHydration({
      allowedSkillId: allowedHydrationSkillIdRef.current,
      currentHydrationKey: hydratedKeyRef.current,
      dirty,
      hasSafeRecovery,
      hydrationKey,
      rejectedHydrationKey: rejectedHydrationKeyRef.current,
      snapshotSkillId: snapshot.draft.id,
    });

    switch (decision.type) {
      case 'already-hydrated': {
        // Returning to the still-active Skill is an explicit reset boundary for a
        // previously rejected target. A later request for that target must ask
        // again instead of being permanently ignored.
        rejectedHydrationKeyRef.current = null;
        return;
      }
      case 'hydrate-allowed': {
        allowedHydrationSkillIdRef.current = null;
        rejectedHydrationKeyRef.current = null;
        switchModalRef.current?.close();
        switchModalRef.current = null;
        hydrateSnapshot(snapshot);
        return;
      }
      case 'skip-rejected': {
        return;
      }
      case 'confirm': {
        pendingSnapshotRef.current = snapshot;
        setPendingSwitchId(snapshot.draft.id);
        if (switchModalRef.current) return;
        switchModalRef.current = confirmModal({
          cancelText: t('skillCatalog.editor.unsaved.stay'),
          content: t('skillCatalog.editor.unsaved.desc'),
          okText: t('skillCatalog.editor.unsaved.leave'),
          title: t('skillCatalog.editor.unsaved.title'),
          onCancel: () => {
            rejectedHydrationKeyRef.current = hydrationKey;
            pendingSnapshotRef.current = null;
            setPendingSwitchId(null);
            switchModalRef.current = null;
          },
          onOk: () => {
            const pending = pendingSnapshotRef.current;
            switchModalRef.current = null;
            if (pending) hydrateSnapshot(pending);
          },
        });
        return;
      }
      case 'hydrate': {
        switchModalRef.current?.close();
        switchModalRef.current = null;
        hydrateSnapshot(snapshot);
      }
    }
  }, [
    activeSnapshot,
    allowedHydrationSkillIdRef,
    dirty,
    draft,
    editable,
    hydratedKeyRef,
    hydrateSnapshot,
    pendingSnapshotRef,
    persistenceStatus,
    rejectedHydrationKeyRef,
    setPendingSwitchId,
    snapshot,
    switchModalRef,
    t,
  ]);
};
