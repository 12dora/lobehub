'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import {
  restoreNoticeKeyForIntent,
  secretEditFromIntent,
  secretIntentFromEdit,
} from './connectorSecretIntent';
import {
  changeConnectorCredentialMode,
  clearConnectorSecretEdit,
  createEmptyConnectorSecretEdit,
  type EditableAdminConnectorDraft,
  toEditableAdminConnectorDraft,
  updateConnectorSecretEdit,
  updateConnectorToolPolicy,
  validateEditableAdminConnectorDraft,
} from './controller';
import {
  clearAdminConnectorDraft,
  loadAdminConnectorDraft,
  saveAdminConnectorDraft,
} from './localDraftStorage';
import type { AdminConnectorGetOutput, AdminConnectorToolDraft } from './types';

export const useConnectorEditor = (
  snapshot: AdminConnectorGetOutput | undefined,
  editable: boolean,
) => {
  const { i18n, t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableAdminConnectorDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<'dirty' | 'failed' | 'idle' | 'saved' | 'saving'>(
    'idle',
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [secret, setSecret] = useState(createEmptyConnectorSecretEdit);
  /** True until the admin re-enters a replacement or explicitly dismisses it. */
  const [requiresSecretReentry, setRequiresSecretReentry] = useState(false);
  /** Stable i18n key — translated at the presentation boundary so locale changes apply. */
  const [restoreNoticeKey, setRestoreNoticeKey] = useState<string | null>(null);
  const hydratedRef = useRef('');
  const recoveryWarningShownRef = useRef(false);

  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;
    if (hydratedRef.current === key) return;
    hydratedRef.current = key;
    recoveryWarningShownRef.current = false;
    const stored = editable ? loadAdminConnectorDraft(snapshot.draft.id) : null;
    setDraft(stored?.draft ?? toEditableAdminConnectorDraft(snapshot.draft));
    setDirty(Boolean(stored));
    setConflict(
      Boolean(
        stored &&
        (stored.baseRevision !== snapshot.baseRevision ||
          stored.draftToken !== snapshot.draftToken),
      ),
    );
    setSaveState(stored ? 'dirty' : 'idle');
    setActionError(null);
    setSecret(secretEditFromIntent(stored?.secretIntent));
    setRequiresSecretReentry(stored?.secretIntent === 'replace_requires_reentry');
    setRestoreNoticeKey(restoreNoticeKeyForIntent(stored?.secretIntent));
  }, [editable, snapshot]);

  const restoreNotice = useMemo(
    () => (restoreNoticeKey ? t(restoreNoticeKey as never) : null),
    // Recompute when language changes so restored warnings are not stuck in a prior locale.
    [i18n.language, restoreNoticeKey, t],
  );

  useEffect(() => {
    if (!editable || !snapshot || !draft || !dirty) return;
    const secretLeaves =
      secret.operation === 'replace' && secret.value ? [secret.value] : undefined;
    const result = saveAdminConnectorDraft(
      snapshot.draft.id,
      {
        baseRevision: snapshot.baseRevision,
        draft,
        draftToken: snapshot.draftToken,
        savedAt: new Date().toISOString(),
        secretIntent: secretIntentFromEdit(secret, requiresSecretReentry),
      },
      { secretLeaves },
    );
    if (result.status === 'unavailable' && !recoveryWarningShownRef.current) {
      recoveryWarningShownRef.current = true;
      toast.warning(t('connectorCatalog.unsaved.recoveryUnavailable'));
    }
  }, [dirty, draft, editable, requiresSecretReentry, secret, snapshot, t]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('connectorCatalog.unsaved.stay'),
      content: t('connectorCatalog.unsaved.description'),
      okText: t('connectorCatalog.unsaved.leave'),
      title: t('connectorCatalog.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: editable && dirty, messages: unsavedMessages });

  /** Every draft edit lands in the same place: local change pending, previous action error void. */
  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveState('dirty');
    setActionError(null);
  }, []);

  /** Any deliberate secret decision retires the restored-replacement sentinel and its notice. */
  const clearSecretReentry = useCallback(() => {
    setRequiresSecretReentry(false);
    setRestoreNoticeKey(null);
  }, []);

  const resetSecretState = useCallback(() => {
    setSecret(createEmptyConnectorSecretEdit());
    clearSecretReentry();
  }, [clearSecretReentry]);

  /** Local copy and server copy agree again — nothing pending, nothing to recover. */
  const settle = useCallback(
    (nextSaveState: 'idle' | 'saved') => {
      setDirty(false);
      setConflict(false);
      setSaveState(nextSaveState);
      setActionError(null);
      resetSecretState();
    },
    [resetSecretState],
  );

  const updateDraft = useCallback(
    <Key extends keyof EditableAdminConnectorDraft>(
      key: Key,
      value: EditableAdminConnectorDraft[Key],
    ) => {
      if (!editable) return;
      if (key === 'credentialMode') {
        setDraft((current) =>
          current
            ? changeConnectorCredentialMode(
                current,
                value as EditableAdminConnectorDraft['credentialMode'],
              )
            : current,
        );
        resetSecretState();
        markDirty();
        return;
      }
      setDraft((current) => (current ? { ...current, [key]: value } : current));
      markDirty();
    },
    [editable, markDirty, resetSecretState],
  );

  const updateTool = useCallback(
    (
      toolId: string,
      patch: Partial<
        Pick<
          AdminConnectorToolDraft,
          'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel' | 'sort'
        >
      >,
    ) => {
      if (!editable) return;
      setDraft((current) =>
        current
          ? { ...current, tools: updateConnectorToolPolicy(current.tools, toolId, patch) }
          : current,
      );
      markDirty();
    },
    [editable, markDirty],
  );

  const changeSecret = useCallback(
    (value: string) => {
      if (!editable) return;
      setSecret(updateConnectorSecretEdit(value));
      // Entering a replacement clears the reentry sentinel.
      clearSecretReentry();
      markDirty();
    },
    [clearSecretReentry, editable, markDirty],
  );

  const clearSecret = useCallback(() => {
    if (!editable) return;
    setSecret(clearConnectorSecretEdit());
    clearSecretReentry();
    markDirty();
  }, [clearSecretReentry, editable, markDirty]);

  const keepSecret = useCallback(() => {
    if (!editable) return;
    resetSecretState();
    markDirty();
  }, [editable, markDirty, resetSecretState]);

  const discardLocal = useCallback(() => {
    if (!snapshot) return;
    clearAdminConnectorDraft(snapshot.draft.id);
    setDraft(toEditableAdminConnectorDraft(snapshot.draft));
    settle('idle');
  }, [settle, snapshot]);

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAdminConnectorDraft(snapshot.draft.id);
    settle('saved');
  }, [settle, snapshot]);

  const validation = useMemo(() => {
    if (!draft) return { errors: {}, valid: false };
    const base = validateEditableAdminConnectorDraft(draft);
    // Block Save until a restored replacement is re-entered or explicitly dismissed.
    if (requiresSecretReentry) return { ...base, valid: false };
    return base;
  }, [draft, requiresSecretReentry]);

  return {
    actionError,
    changeSecret,
    clearSecret,
    conflict,
    dirty,
    discardLocal,
    draft,
    keepSecret,
    markSaved,
    /** True when a restored replacement must be re-entered before save. */
    requiresSecretReentry,
    restoreNotice,
    saveState,
    secret,
    setActionError,
    setConflict,
    setSaveState,
    updateDraft,
    updateTool,
    validation,
  };
};
