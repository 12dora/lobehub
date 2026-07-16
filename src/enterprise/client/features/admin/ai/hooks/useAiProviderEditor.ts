'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import {
  type AiCatalogSaveState,
  type AiProviderRebaseConflict,
  deriveAiProviderConnectionTestView,
  type EditableAiProviderDraft,
  rebaseAiProviderDraft,
  toEditableAiProviderDraft,
  validateEditableAiProviderDraft,
} from '../controller';
import {
  clearAiProviderPublicDraft,
  loadAiProviderPublicDraft,
  saveAiProviderPublicDraft,
} from '../localDraftStorage';
import type { AdminAiProviderGetOutput } from '../types';

export const useAiProviderEditor = (snapshot: AdminAiProviderGetOutput | undefined) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableAiProviderDraft | null>(null);
  const [baseDraft, setBaseDraft] = useState<EditableAiProviderDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<AiCatalogSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [testLocallyStale, setTestLocallyStale] = useState(false);
  const [rebaseConflicts, setRebaseConflicts] = useState<AiProviderRebaseConflict[]>([]);
  const hydratedKeyRef = useRef<string | null>(null);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;

    const local = loadAiProviderPublicDraft(snapshot.draft.id);
    if (local) {
      setBaseDraft(local.baseDraft);
      setDraft(local.draft);
      setRebaseConflicts([]);
      setDirty(true);
      setTestLocallyStale(true);
      setSaveState('dirty');
      setConflict(
        local.baseRevision !== snapshot.baseRevision || local.draftToken !== snapshot.draftToken,
      );
      return;
    }

    const latest = toEditableAiProviderDraft(snapshot.draft);
    setBaseDraft(latest);
    setDraft(latest);
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setTestLocallyStale(false);
    setRebaseConflicts([]);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !draft || !dirty) return;
    saveAiProviderPublicDraft(snapshot.draft.id, {
      baseDraft: baseDraft ?? toEditableAiProviderDraft(snapshot.draft),
      baseRevision: snapshot.baseRevision,
      draft,
      draftToken: snapshot.draftToken,
      savedAt: new Date().toISOString(),
    });
  }, [baseDraft, dirty, draft, snapshot]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      leaveModalRef.current?.close();
      leaveModalRef.current = null;
      return;
    }
    if (leaveModalRef.current) return;
    leaveModalRef.current = confirmModal({
      cancelText: t('aiCatalog.editor.unsaved.stay'),
      content: t('aiCatalog.editor.unsaved.desc'),
      okText: t('aiCatalog.editor.unsaved.leave'),
      title: t('aiCatalog.editor.unsaved.title'),
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

  const updateDraft = useCallback(
    <Key extends keyof EditableAiProviderDraft>(key: Key, value: EditableAiProviderDraft[Key]) => {
      setDraft((current) => (current ? { ...current, [key]: value } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setTestLocallyStale(true);
    },
    [],
  );

  const discardLocal = useCallback(() => {
    if (!snapshot) return;
    clearAiProviderPublicDraft(snapshot.draft.id);
    const latest = toEditableAiProviderDraft(snapshot.draft);
    setBaseDraft(latest);
    setDraft(latest);
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setTestLocallyStale(false);
    setRebaseConflicts([]);
  }, [snapshot]);

  const rebaseLocal = useCallback(
    (latestSnapshot?: AdminAiProviderGetOutput) => {
      const source = latestSnapshot ?? snapshot;
      if (!source || !draft || !baseDraft) return;
      const latest = toEditableAiProviderDraft(source.draft);
      const result = rebaseAiProviderDraft({ latest, local: draft, original: baseDraft });
      setBaseDraft(latest);
      setDraft(result.draft);
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setTestLocallyStale(true);
      setRebaseConflicts(result.conflicts);
      setConflict(result.conflicts.length > 0);
    },
    [baseDraft, draft, snapshot],
  );

  const resolveRebaseConflict = useCallback(
    (field: keyof EditableAiProviderDraft, choice: 'latest' | 'local') => {
      const conflictItem = rebaseConflicts.find((item) => item.field === field);
      if (!conflictItem) return;
      setDraft((current) =>
        current ? { ...current, [field]: structuredClone(conflictItem[choice]) } : current,
      );
      setRebaseConflicts((current) => {
        const next = current.filter((item) => item.field !== field);
        if (next.length === 0) setConflict(false);
        return next;
      });
      setDirty(true);
      setSaveState('dirty');
      setTestLocallyStale(true);
    },
    [rebaseConflicts],
  );

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAiProviderPublicDraft(snapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    setRebaseConflicts([]);
  }, [snapshot]);

  const validation = draft ? validateEditableAiProviderDraft(draft) : null;
  const connectionTest = snapshot
    ? deriveAiProviderConnectionTestView({
        baseRevision: snapshot.baseRevision,
        draftToken: snapshot.draftToken,
        locallyStale: testLocallyStale,
        state: snapshot.draft.connectionTest,
      })
    : { canPublish: false, stale: false, state: null };

  return {
    actionError,
    baseDraft,
    conflict,
    connectionTest,
    dirty,
    discardLocal,
    draft,
    markSaved,
    invalidateTest: () => setTestLocallyStale(true),
    jsonErrors: {
      configText: validation?.config.error ?? null,
      settingsText: validation?.settings.error ?? null,
    },
    rebaseConflicts,
    rebaseLocal,
    resolveRebaseConflict,
    saveState,
    setActionError,
    setConflict,
    setSaveState,
    updateDraft,
    valid: validation?.valid ?? false,
  };
};
