'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import {
  clearAdminAgentDraft,
  loadAdminAgentDraft,
  saveAdminAgentDraft,
} from './localDraftStorage';
import type { AdminAgentDetailOutput, AdminAgentDraft } from './types';

const nextVersion = (version: string | undefined) => {
  const [major = '0', minor = '0', patch = '0'] = (version ?? '0.0.0').split('.');
  return `${major}.${minor}.${Number(patch) + 1}`;
};

const toDraft = (snapshot: AdminAgentDetailOutput): AdminAgentDraft => {
  const current = snapshot.versions.find(({ id }) => id === snapshot.identity.currentVersionId);
  const version = snapshot.versions[0] ?? current;
  return version
    ? {
        config: structuredClone(version.config),
        dependencySnapshot: structuredClone(version.dependencySnapshot),
        version: nextVersion(version.version),
      }
    : {
        config: {
          avatar: null,
          backgroundColor: null,
          description: null,
          displayName: snapshot.identity.agentKey,
          modelParameters: {},
          openingMessage: null,
          openingQuestions: [],
          systemRole: 'You are a helpful organization Agent.',
          tags: [],
        },
        dependencySnapshot: {
          connectors: [],
          model: {
            modelKey: 'model-key',
            providerChecksum: '0'.repeat(64),
            providerKey: 'provider-key',
            providerRevision: 1,
          },
          skills: [],
        },
        version: '0.1.0',
      };
};

export const useAgentEditor = (snapshot: AdminAgentDetailOutput | undefined, editable: boolean) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<AdminAgentDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<'dirty' | 'failed' | 'idle' | 'saved' | 'saving'>(
    'idle',
  );
  const hydratedRef = useRef('');
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.identity.id}:${snapshot.identity.revision}:${snapshot.draftToken}:${editable}`;
    if (hydratedRef.current === key) return;
    hydratedRef.current = key;
    const stored = editable ? loadAdminAgentDraft(snapshot.identity.id) : null;
    setDraft(stored?.draft ?? toDraft(snapshot));
    setDirty(Boolean(stored));
    setConflict(
      Boolean(
        stored &&
        (stored.revision !== snapshot.identity.revision ||
          stored.draftToken !== snapshot.draftToken),
      ),
    );
    setSaveState(stored ? 'dirty' : 'idle');
  }, [editable, snapshot]);

  useEffect(() => {
    if (!editable || !snapshot || !draft || !dirty) return;
    saveAdminAgentDraft(snapshot.identity.id, {
      draft,
      draftToken: snapshot.draftToken,
      revision: snapshot.identity.revision,
      savedAt: new Date().toISOString(),
    });
  }, [dirty, draft, editable, snapshot]);

  useEffect(() => {
    if (!editable || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
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
      cancelText: t('agentCatalog.unsaved.stay'),
      content: t('agentCatalog.unsaved.description'),
      okText: t('agentCatalog.unsaved.leave'),
      title: t('agentCatalog.unsaved.title'),
      onCancel: () => blocker.reset?.(),
      onOk: () => blocker.proceed?.(),
    });
  }, [blocker, t]);

  const updateDraft = useCallback(
    (updater: (current: AdminAgentDraft) => AdminAgentDraft) => {
      if (!editable) return;
      setDraft((current) => (current ? updater(current) : current));
      setDirty(true);
      setSaveState('dirty');
    },
    [editable],
  );

  const discard = useCallback(() => {
    if (!snapshot) return;
    clearAdminAgentDraft(snapshot.identity.id);
    setDraft(toDraft(snapshot));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
  }, [snapshot]);

  const markSaved = useCallback(() => {
    if (!snapshot) return;
    clearAdminAgentDraft(snapshot.identity.id);
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
  }, [snapshot]);

  return {
    conflict,
    dirty,
    discard,
    draft,
    markSaved,
    saveState,
    setConflict,
    setSaveState,
    updateDraft,
  };
};
