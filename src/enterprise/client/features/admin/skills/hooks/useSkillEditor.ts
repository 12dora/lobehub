'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import {
  type EditableSkillDraft,
  type EditableSkillIdentityDraft,
  type EditableSkillVersionDraft,
  fingerprintSkillDraft,
  rebaseSkillDraft,
  shouldConfirmSkillHydration,
  type SkillRebaseConflict,
  type SkillSaveState,
  toEditableSkillDraft,
} from '../controller';
import {
  clearSkillLocalDraft,
  loadSkillLocalDraft,
  saveSkillLocalDraft,
  type SkillDraftPersistenceStatus,
} from '../localDraftStorage';
import type { AdminSkillGetOutput } from '../types';

const hydrationKeyOf = (snapshot: AdminSkillGetOutput, editable: boolean) =>
  `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;

export const useSkillEditor = (snapshot: AdminSkillGetOutput | undefined, editable = true) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableSkillDraft | null>(null);
  const [baseDraft, setBaseDraft] = useState<EditableSkillDraft | null>(null);
  const [recoveryBaseRevision, setRecoveryBaseRevision] = useState<number>();
  const [recoveryBaseDraftSequence, setRecoveryBaseDraftSequence] = useState<number>();
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<SkillSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<SkillDraftPersistenceStatus>('saved');
  const [rebaseConflicts, setRebaseConflicts] = useState<SkillRebaseConflict[]>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<AdminSkillGetOutput>();
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const rejectedHydrationKeyRef = useRef<string | null>(null);
  const pendingSnapshotRef = useRef<AdminSkillGetOutput | null>(null);
  const allowNextHydrationRef = useRef(false);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);
  const switchModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  const hydrateSnapshot = useCallback(
    (nextSnapshot: AdminSkillGetOutput) => {
      hydratedKeyRef.current = hydrationKeyOf(nextSnapshot, editable);
      rejectedHydrationKeyRef.current = null;
      pendingSnapshotRef.current = null;
      setPendingSwitchId(null);
      setActiveSnapshot(nextSnapshot);

      const latest = toEditableSkillDraft(nextSnapshot);
      const local = editable ? loadSkillLocalDraft(nextSnapshot.draft.id) : null;
      if (local) {
        const staleBase =
          local.baseRevision !== nextSnapshot.baseRevision ||
          local.baseDraftSequence !== nextSnapshot.draft.draftSequence ||
          fingerprintSkillDraft(local.baseDraft) !== fingerprintSkillDraft(latest);
        setBaseDraft(local.baseDraft);
        setRecoveryBaseRevision(local.baseRevision);
        setRecoveryBaseDraftSequence(local.baseDraftSequence);
        setDraft(local.draft);
        setDirty(true);
        setConflict(staleBase);
        setSaveState('dirty');
        setActionError(null);
        setPersistenceStatus('saved');
        setRebaseConflicts([]);
        return;
      }

      setBaseDraft(latest);
      setRecoveryBaseRevision(nextSnapshot.baseRevision);
      setRecoveryBaseDraftSequence(nextSnapshot.draft.draftSequence);
      setDraft(latest);
      setDirty(false);
      setConflict(false);
      setSaveState('idle');
      setActionError(null);
      setPersistenceStatus('saved');
      setRebaseConflicts([]);
    },
    [editable],
  );

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = hydrationKeyOf(snapshot, editable);
    if (hydratedKeyRef.current === hydrationKey) {
      // Returning to the still-active Skill is an explicit reset boundary for a
      // previously rejected target. A later request for that target must ask
      // again instead of being permanently ignored.
      rejectedHydrationKeyRef.current = null;
      return;
    }
    if (allowNextHydrationRef.current) {
      allowNextHydrationRef.current = false;
      rejectedHydrationKeyRef.current = null;
      switchModalRef.current?.close();
      switchModalRef.current = null;
      hydrateSnapshot(snapshot);
      return;
    }
    if (rejectedHydrationKeyRef.current === hydrationKey) {
      return;
    }

    const storedCurrent =
      dirty && activeSnapshot && draft && persistenceStatus === 'saved'
        ? loadSkillLocalDraft(activeSnapshot.draft.id)
        : null;
    const hasSafeRecovery = Boolean(
      storedCurrent &&
      draft &&
      fingerprintSkillDraft(storedCurrent.draft) === fingerprintSkillDraft(draft),
    );

    if (
      shouldConfirmSkillHydration({
        currentHydrationKey: hydratedKeyRef.current,
        dirty,
        hasSafeRecovery,
        nextHydrationKey: hydrationKey,
      })
    ) {
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

    switchModalRef.current?.close();
    switchModalRef.current = null;
    hydrateSnapshot(snapshot);
  }, [activeSnapshot, dirty, draft, editable, hydrateSnapshot, persistenceStatus, snapshot, t]);

  useEffect(() => {
    if (
      !editable ||
      !activeSnapshot ||
      !draft ||
      !dirty ||
      recoveryBaseRevision === undefined ||
      recoveryBaseDraftSequence === undefined
    ) {
      return;
    }
    const status = saveSkillLocalDraft(activeSnapshot.draft.id, {
      baseDraft: baseDraft ?? toEditableSkillDraft(activeSnapshot),
      baseDraftSequence: recoveryBaseDraftSequence,
      baseRevision: recoveryBaseRevision,
      draft,
      savedAt: new Date().toISOString(),
    });
    setPersistenceStatus(status);
  }, [
    activeSnapshot,
    baseDraft,
    dirty,
    draft,
    editable,
    recoveryBaseDraftSequence,
    recoveryBaseRevision,
  ]);

  useEffect(() => {
    if (!editable || !dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty, editable]);

  const blocker = useBlocker(
    editable && dirty
      ? ({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname
      : false,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      leaveModalRef.current?.close();
      leaveModalRef.current = null;
      return;
    }
    if (leaveModalRef.current) return;
    leaveModalRef.current = confirmModal({
      cancelText: t('skillCatalog.editor.unsaved.stay'),
      content: t('skillCatalog.editor.unsaved.desc'),
      okText: t('skillCatalog.editor.unsaved.leave'),
      title: t('skillCatalog.editor.unsaved.title'),
      onCancel: () => {
        leaveModalRef.current = null;
        blocker.reset?.();
      },
      onOk: () => {
        allowNextHydrationRef.current = true;
        leaveModalRef.current = null;
        blocker.proceed?.();
      },
    });
  }, [blocker.proceed, blocker.reset, blocker.state, t]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
      switchModalRef.current?.destroy();
      switchModalRef.current = null;
    },
    [],
  );

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
    [editable],
  );

  const updateVersionDraft = useCallback(
    (versionDraft: EditableSkillVersionDraft | null) => {
      if (!editable) return;
      setDraft((current) => (current ? { ...current, versionDraft } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable],
  );

  const discardLocal = useCallback(() => {
    if (!activeSnapshot) return;
    clearSkillLocalDraft(activeSnapshot.draft.id);
    const latest = toEditableSkillDraft(activeSnapshot);
    setBaseDraft(latest);
    setRecoveryBaseRevision(activeSnapshot.baseRevision);
    setRecoveryBaseDraftSequence(activeSnapshot.draft.draftSequence);
    setDraft(latest);
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setPersistenceStatus('saved');
    setRebaseConflicts([]);
  }, [activeSnapshot]);

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
    [activeSnapshot, baseDraft, draft, editable],
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
    [rebaseConflicts],
  );

  const markSaved = useCallback(() => {
    if (!activeSnapshot) return;
    clearSkillLocalDraft(activeSnapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    setPersistenceStatus('saved');
    setRebaseConflicts([]);
  }, [activeSnapshot]);

  return {
    actionError,
    activeSkillId: activeSnapshot?.draft.id ?? null,
    baseDraft,
    conflict,
    dirty,
    discardLocal,
    draft,
    markSaved,
    pendingSwitchId,
    persistenceStatus,
    rebaseConflicts,
    rebaseLocal,
    resolveRebaseConflict,
    saveState,
    setActionError,
    setConflict,
    setSaveState,
    updateIdentity,
    updateVersionDraft,
  };
};
