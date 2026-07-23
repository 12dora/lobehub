'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

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
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<EditableAdminConnectorDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<'dirty' | 'failed' | 'idle' | 'saved' | 'saving'>(
    'idle',
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [secret, setSecret] = useState(createEmptyConnectorSecretEdit);
  const hydratedRef = useRef('');
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;
    if (hydratedRef.current === key) return;
    hydratedRef.current = key;
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
    setSecret(createEmptyConnectorSecretEdit());
  }, [editable, snapshot]);

  useEffect(() => {
    if (!editable || !snapshot || !draft || !dirty) return;
    saveAdminConnectorDraft(snapshot.draft.id, {
      baseRevision: snapshot.baseRevision,
      draft,
      draftToken: snapshot.draftToken,
      savedAt: new Date().toISOString(),
    });
  }, [dirty, draft, editable, snapshot]);

  useEffect(() => {
    if (!editable || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
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
      cancelText: t('connectorCatalog.unsaved.stay'),
      content: t('connectorCatalog.unsaved.description'),
      okText: t('connectorCatalog.unsaved.leave'),
      title: t('connectorCatalog.unsaved.title'),
      onCancel: () => blocker.reset?.(),
      onOk: () => blocker.proceed?.(),
    });
  }, [blocker, t]);

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
                secret,
              ).draft
            : current,
        );
        setSecret(createEmptyConnectorSecretEdit());
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
    [editable, secret],
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
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [editable],
  );

  const clearSecret = useCallback(() => {
    if (!editable) return;
    setSecret(clearConnectorSecretEdit());
    setDirty(true);
    setSaveState('dirty');
    setActionError(null);
  }, [editable]);

  const keepSecret = useCallback(() => {
    if (!editable) return;
    setSecret(createEmptyConnectorSecretEdit());
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
  }, [snapshot]);

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAdminConnectorDraft(snapshot.draft.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setActionError(null);
    setSecret(createEmptyConnectorSecretEdit());
  }, [snapshot]);

  const validation = useMemo(
    () => (draft ? validateEditableAdminConnectorDraft(draft) : { errors: {}, valid: false }),
    [draft],
  );

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
