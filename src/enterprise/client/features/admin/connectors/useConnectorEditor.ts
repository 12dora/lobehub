'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import {
  changeConnectorCredentialMode,
  clearConnectorSecretEdit,
  type ConnectorSecretEdit,
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
  type StoredConnectorSecretIntent,
} from './localDraftStorage';
import type { AdminConnectorGetOutput, AdminConnectorToolDraft } from './types';

/**
 * Map live secret edit → durable intent. When the admin previously typed a
 * replacement that was not yet saved, we retain `replace_requires_reentry`
 * even though the bytes themselves are never stored.
 */
const secretIntentFromEdit = (
  edit: ConnectorSecretEdit,
  requiresReentry: boolean,
): StoredConnectorSecretIntent => {
  if (edit.operation === 'clear') return 'clear';
  if (edit.operation === 'replace') return 'replace_requires_reentry';
  if (requiresReentry) return 'replace_requires_reentry';
  return 'keep';
};

const secretEditFromIntent = (
  intent: StoredConnectorSecretIntent | undefined,
): ConnectorSecretEdit => {
  if (intent === 'clear') return clearConnectorSecretEdit();
  // Replacement bytes are never stored — admin must re-enter after restore.
  return createEmptyConnectorSecretEdit();
};

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
    const needsReentry = stored?.secretIntent === 'replace_requires_reentry';
    setRequiresSecretReentry(needsReentry);
    setRestoreNoticeKey(
      needsReentry
        ? 'connectorCatalog.unsaved.secretReentry'
        : stored?.secretIntent === 'clear'
          ? 'connectorCatalog.unsaved.secretClearRestored'
          : null,
    );
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
        setSecret(createEmptyConnectorSecretEdit());
        setRequiresSecretReentry(false);
        setRestoreNoticeKey(null);
        setDirty(true);
        setSaveState('dirty');
        setActionError(null);
        return;
      }
      setDraft((current) => (current ? { ...current, [key]: value } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable],
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
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable],
  );

  const changeSecret = useCallback(
    (value: string) => {
      if (!editable) return;
      setSecret(updateConnectorSecretEdit(value));
      // Entering a replacement clears the reentry sentinel.
      setRequiresSecretReentry(false);
      setRestoreNoticeKey(null);
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable],
  );

  const clearSecret = useCallback(() => {
    if (!editable) return;
    setSecret(clearConnectorSecretEdit());
    setRequiresSecretReentry(false);
    setRestoreNoticeKey(null);
    setDirty(true);
    setSaveState('dirty');
    setActionError(null);
  }, [editable]);

  const keepSecret = useCallback(() => {
    if (!editable) return;
    setSecret(createEmptyConnectorSecretEdit());
    setRequiresSecretReentry(false);
    setRestoreNoticeKey(null);
    setDirty(true);
    setSaveState('dirty');
    setActionError(null);
  }, [editable]);

  const discardLocal = useCallback(() => {
    if (!snapshot) return;
    clearAdminConnectorDraft(snapshot.draft.id);
    setDraft(toEditableAdminConnectorDraft(snapshot.draft));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setActionError(null);
    setSecret(createEmptyConnectorSecretEdit());
    setRequiresSecretReentry(false);
    setRestoreNoticeKey(null);
  }, [snapshot]);

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAdminConnectorDraft(snapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    setSecret(createEmptyConnectorSecretEdit());
    setRequiresSecretReentry(false);
    setRestoreNoticeKey(null);
  }, [snapshot]);

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
