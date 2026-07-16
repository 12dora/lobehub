'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import {
  type EditableSkillDraft,
  type EditableSkillIdentityDraft,
  type EditableSkillVersionDraft,
  rebaseSkillDraft,
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

export const useSkillEditor = (snapshot: AdminSkillGetOutput | undefined, editable = true) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableSkillDraft | null>(null);
  const [baseDraft, setBaseDraft] = useState<EditableSkillDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<SkillSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<SkillDraftPersistenceStatus>('saved');
  const [rebaseConflicts, setRebaseConflicts] = useState<SkillRebaseConflict[]>([]);
  const hydratedKeyRef = useRef<string | null>(null);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;

    const local = editable ? loadSkillLocalDraft(snapshot.draft.id) : null;
    if (local) {
      setBaseDraft(local.baseDraft);
      setDraft(local.draft);
      setDirty(true);
      setConflict(local.baseRevision !== snapshot.baseRevision);
      setSaveState('dirty');
      setActionError(null);
      setPersistenceStatus('saved');
      setRebaseConflicts([]);
      return;
    }

    const latest = toEditableSkillDraft(snapshot);
    setBaseDraft(latest);
    setDraft(latest);
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setPersistenceStatus('saved');
    setRebaseConflicts([]);
  }, [editable, snapshot]);

  useEffect(() => {
    if (!editable || !snapshot || !draft || !dirty) return;
    const status = saveSkillLocalDraft(snapshot.draft.id, {
      baseDraft: baseDraft ?? toEditableSkillDraft(snapshot),
      baseRevision: snapshot.baseRevision,
      draft,
      savedAt: new Date().toISOString(),
    });
    setPersistenceStatus(status);
  }, [baseDraft, dirty, draft, editable, snapshot]);

  useEffect(() => {
    if (!editable || !dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty, editable]);

  const blocker = useBlocker(editable && dirty);
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
        leaveModalRef.current = null;
        blocker.proceed?.();
      },
    });
  }, [blocker.proceed, blocker.reset, blocker.state, t]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
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
    if (!snapshot) return;
    clearSkillLocalDraft(snapshot.draft.id);
    const latest = toEditableSkillDraft(snapshot);
    setBaseDraft(latest);
    setDraft(latest);
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setPersistenceStatus('saved');
    setRebaseConflicts([]);
  }, [snapshot]);

  const rebaseLocal = useCallback(
    (latestSnapshot?: AdminSkillGetOutput) => {
      const source = latestSnapshot ?? snapshot;
      if (!source || !draft || !baseDraft) return;
      const latest = toEditableSkillDraft(source);
      const result = rebaseSkillDraft({ latest, local: draft, original: baseDraft });
      setBaseDraft(latest);
      setDraft(result.draft);
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setRebaseConflicts(result.conflicts);
      setConflict(result.conflicts.length > 0);
    },
    [baseDraft, draft, snapshot],
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
    if (!snapshot) return;
    clearSkillLocalDraft(snapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    setPersistenceStatus('saved');
    setRebaseConflicts([]);
  }, [snapshot]);

  return {
    actionError,
    baseDraft,
    conflict,
    dirty,
    discardLocal,
    draft,
    markSaved,
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
