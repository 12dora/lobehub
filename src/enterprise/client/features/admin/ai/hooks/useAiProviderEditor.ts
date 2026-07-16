'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import {
  type AiCatalogSaveState,
  type EditableAiProviderDraft,
  toEditableAiProviderDraft,
} from '../controller';
import {
  clearAiProviderPublicDraft,
  loadAiProviderPublicDraft,
  saveAiProviderPublicDraft,
} from '../localDraftStorage';
import type { AdminAiProviderGetOutput, AiConnectionTestResult } from '../types';

export const useAiProviderEditor = (snapshot: AdminAiProviderGetOutput | undefined) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableAiProviderDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<AiCatalogSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;

    const local = loadAiProviderPublicDraft(snapshot.draft.id);
    if (local) {
      setDraft(local.draft);
      setDirty(true);
      setSaveState('dirty');
      setConflict(
        local.baseRevision !== snapshot.baseRevision || local.draftToken !== snapshot.draftToken,
      );
      return;
    }

    setDraft(toEditableAiProviderDraft(snapshot.draft));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setTestResult(null);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !draft || !dirty) return;
    saveAiProviderPublicDraft(snapshot.draft.id, {
      baseRevision: snapshot.baseRevision,
      draft,
      draftToken: snapshot.draftToken,
      savedAt: new Date().toISOString(),
    });
  }, [dirty, draft, snapshot]);

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
      setTestResult(null);
    },
    [],
  );

  const discardLocal = useCallback(() => {
    if (!snapshot) return;
    clearAiProviderPublicDraft(snapshot.draft.id);
    setDraft(toEditableAiProviderDraft(snapshot.draft));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setTestResult(null);
  }, [snapshot]);

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAiProviderPublicDraft(snapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
  }, [snapshot]);

  return {
    actionError,
    conflict,
    dirty,
    discardLocal,
    draft,
    markSaved,
    saveState,
    setActionError,
    setConflict,
    setSaveState,
    setTestResult,
    testResult,
    updateDraft,
  };
};
