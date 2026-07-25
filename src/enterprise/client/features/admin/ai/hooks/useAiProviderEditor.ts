'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
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

/** CAS identity attached to the local recovery draft (may lag the live snapshot). */
type LocalCasIdentity = { baseRevision: number; draftToken: string };

export const useAiProviderEditor = (
  snapshot: AdminAiProviderGetOutput | undefined,
  editable = true,
) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableAiProviderDraft | null>(null);
  const [baseDraft, setBaseDraft] = useState<EditableAiProviderDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<AiCatalogSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [testLocallyStale, setTestLocallyStale] = useState(false);
  const [rebaseConflicts, setRebaseConflicts] = useState<AiProviderRebaseConflict[]>([]);
  /**
   * Persisted CAS metadata for the recovery draft. Must survive hydration against a
   * newer server snapshot so conflict detection is not silently erased on the next write.
   * Updated only on explicit rebase / discard / save against a fresh snapshot.
   */
  const [localCas, setLocalCas] = useState<LocalCasIdentity | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const hydrationKey = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;

    const local = editable ? loadAiProviderPublicDraft(snapshot.draft.id) : null;
    if (local) {
      setBaseDraft(local.baseDraft);
      setDraft(local.draft);
      setRebaseConflicts([]);
      setDirty(true);
      setTestLocallyStale(true);
      setSaveState('dirty');
      // Preserve the draft's own CAS identity — do not rewrite to the live snapshot.
      setLocalCas({ baseRevision: local.baseRevision, draftToken: local.draftToken });
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
    setLocalCas({ baseRevision: snapshot.baseRevision, draftToken: snapshot.draftToken });
  }, [editable, snapshot]);

  useEffect(() => {
    if (!editable || !snapshot || !draft || !dirty) return;
    // Always re-persist the draft's original CAS identity, not the live snapshot's.
    const cas = localCas ?? {
      baseRevision: snapshot.baseRevision,
      draftToken: snapshot.draftToken,
    };
    saveAiProviderPublicDraft(snapshot.draft.id, {
      baseDraft: baseDraft ?? toEditableAiProviderDraft(snapshot.draft),
      baseRevision: cas.baseRevision,
      draft,
      draftToken: cas.draftToken,
      savedAt: new Date().toISOString(),
    });
  }, [baseDraft, dirty, draft, editable, localCas, snapshot]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('aiCatalog.editor.unsaved.stay'),
      content: t('aiCatalog.editor.unsaved.desc'),
      okText: t('aiCatalog.editor.unsaved.leave'),
      title: t('aiCatalog.editor.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: editable && dirty, messages: unsavedMessages });

  const updateDraft = useCallback(
    <Key extends keyof EditableAiProviderDraft>(key: Key, value: EditableAiProviderDraft[Key]) => {
      if (!editable) return;
      setDraft((current) => (current ? { ...current, [key]: value } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setTestLocallyStale(true);
    },
    [editable],
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
    // Discard adopts the live snapshot CAS identity.
    setLocalCas({ baseRevision: snapshot.baseRevision, draftToken: snapshot.draftToken });
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
      // Explicit rebase advances the local draft onto the server's CAS identity.
      setLocalCas({ baseRevision: source.baseRevision, draftToken: source.draftToken });
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
    // Successful save against the current snapshot refreshes local CAS identity.
    setLocalCas({ baseRevision: snapshot.baseRevision, draftToken: snapshot.draftToken });
  }, [snapshot]);

  const validation = useMemo(
    () => (draft ? validateEditableAiProviderDraft(draft) : null),
    [draft],
  );
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
