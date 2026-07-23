'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import {
  clearAdminAgentDraft,
  type DraftPersistStatus,
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
        // Carry the previous version's exact model/skill/connector refs; the operator re-picks
        // to switch, which replaces the full ref with fresh catalog metadata.
        dependencies: {
          connectors: structuredClone(version.dependencySnapshot.connectors),
          model: structuredClone(version.dependencySnapshot.model),
          skills: structuredClone(version.dependencySnapshot.skills),
        },
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
        // No fabricated model — a first version must pick an exact published model.
        dependencies: { connectors: [], model: null, skills: [] },
        version: '0.1.0',
      };
};

export interface AgentDraftBaseline {
  agentId: string;
  draftToken: string;
  revision: number;
}

const baselineFromSnapshot = (snapshot: AdminAgentDetailOutput): AgentDraftBaseline => ({
  agentId: snapshot.identity.id,
  draftToken: snapshot.draftToken,
  revision: snapshot.identity.revision,
});

const sameBaseline = (left: AgentDraftBaseline, right: AgentDraftBaseline) =>
  left.agentId === right.agentId &&
  left.revision === right.revision &&
  left.draftToken === right.draftToken;

export const useAgentEditor = (snapshot: AdminAgentDetailOutput | undefined, editable: boolean) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<AdminAgentDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<
    'dirty' | 'failed' | 'idle' | 'refreshFailed' | 'saved' | 'saving'
  >('idle');
  const [persistState, setPersistState] = useState<DraftPersistStatus | null>(null);
  // Frozen origin CAS for the current draft. It is intentionally independent from the live SWR
  // snapshot: a background refresh must never silently rebase a dirty form or rewrite its recovery
  // envelope to a CAS the draft was not authored from.
  const [draftBaseline, setDraftBaseline] = useState<AgentDraftBaseline | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const incoming = baselineFromSnapshot(snapshot);

    // Hydrate once per Agent context. A stored dirty draft keeps the CAS it was authored against,
    // even when the first authoritative snapshot has already advanced.
    if (draftBaseline?.agentId === incoming.agentId) {
      if (dirty && !sameBaseline(draftBaseline, incoming)) setConflict(true);
      return;
    }

    const stored = editable ? loadAdminAgentDraft(snapshot.identity.id) : null;
    setDraftBaseline(
      stored
        ? {
            agentId: snapshot.identity.id,
            draftToken: stored.draftToken,
            revision: stored.revision,
          }
        : incoming,
    );
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
    setPersistState(stored ? 'saved' : null);
  }, [dirty, draftBaseline, editable, snapshot]);

  useEffect(() => {
    if (!editable || !draftBaseline || !draft || !dirty) return;
    const status = saveAdminAgentDraft(draftBaseline.agentId, {
      draft,
      draftToken: draftBaseline.draftToken,
      revision: draftBaseline.revision,
      savedAt: new Date().toISOString(),
    });
    setPersistState(status);
  }, [dirty, draft, draftBaseline, editable]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('agentCatalog.unsaved.stay'),
      content: t('agentCatalog.unsaved.description'),
      okText: t('agentCatalog.unsaved.leave'),
      title: t('agentCatalog.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: editable && dirty, messages: unsavedMessages });

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
    setDraftBaseline(baselineFromSnapshot(snapshot));
    setDraft(toDraft(snapshot));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setPersistState(null);
  }, [snapshot]);

  const markSaved = useCallback((baseline: AgentDraftBaseline) => {
    clearAdminAgentDraft(baseline.agentId);
    setDraftBaseline(baseline);
    // The just-saved draft is now the source for the next immutable version.
    setDraft((current) =>
      current ? { ...current, version: nextVersion(current.version) } : current,
    );
    setDirty(false);
    setConflict(false);
    setSaveState('saved');
    setPersistState(null);
  }, []);

  return {
    conflict,
    draftBaseline,
    dirty,
    discard,
    draft,
    markSaved,
    persistState,
    saveState,
    setConflict,
    setSaveState,
    updateDraft,
  };
};
