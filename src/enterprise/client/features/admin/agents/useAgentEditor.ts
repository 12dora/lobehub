'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import {
  clearAdminAgentDraft,
  type DraftPersistStatus,
  loadAdminAgentDraft,
} from './localDraftStorage';
import type { AdminAgentDetailOutput, AdminAgentDraft } from './types';
import { useAdminAgentDraftPersistence } from './useAdminAgentDraftPersistence';
import { selectDraftSourcePlatformAgentVersion } from './versionSelection';

/**
 * Bump the patch of a SemVer-like label for the next immutable draft.
 * Strips prerelease (`-…`) and build (`+…`) metadata so valid forms like
 * `1.2.3+build.5` / `1.2.3-alpha.1` never produce `NaN` patch components.
 */
export const nextVersion = (version: string | undefined): string => {
  const raw = (version ?? '0.0.0').trim();
  // Core MAJOR.MINOR.PATCH only — drop prerelease / build per explicit draft policy.
  const core = raw.split(/[-+]/, 1)[0] || '0.0.0';
  const [majorText = '0', minorText = '0', patchText = '0'] = core.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return '0.0.1';
  }
  return `${major}.${minor}.${patch + 1}`;
};

const toDraft = (snapshot: AdminAgentDetailOutput, defaultSystemRole = ''): AdminAgentDraft => {
  // Newest created version (canonical order) — never opaque array position / versions[0].
  const version = selectDraftSourcePlatformAgentVersion(snapshot);
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
          // Localized by the editor hook — never hardcode English into the persisted draft.
          systemRole: defaultSystemRole,
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
  const defaultSystemRole = t('agentCatalog.editor.defaultSystemRole');
  const [draft, setDraft] = useState<AdminAgentDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<
    'dirty' | 'failed' | 'idle' | 'refreshFailed' | 'saved' | 'saving'
  >('idle');
  // Frozen origin CAS for the current draft. It is intentionally independent from the live SWR
  // snapshot: a background refresh must never silently rebase a dirty form or rewrite its recovery
  // envelope to a CAS the draft was not authored from.
  const [draftBaseline, setDraftBaseline] = useState<AgentDraftBaseline | null>(null);
  // Seeded when a recovery draft is hydrated so the UI can show "saved" before the first edit.
  const [hydratedPersistState, setHydratedPersistState] = useState<DraftPersistStatus | null>(null);

  useEffect(() => {
    // While the route identity is loading/transitioning, drop any previous agent's editor state so
    // a subsequent hydrate cannot paint B with A's draft for one frame.
    if (!snapshot) {
      if (draftBaseline || draft) {
        setDraftBaseline(null);
        setDraft(null);
        setDirty(false);
        setConflict(false);
        setSaveState('idle');
        setHydratedPersistState(null);
      }
      return;
    }
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
    setDraft(stored?.draft ?? toDraft(snapshot, defaultSystemRole));
    setDirty(Boolean(stored));
    setConflict(
      Boolean(
        stored &&
        (stored.revision !== snapshot.identity.revision ||
          stored.draftToken !== snapshot.draftToken),
      ),
    );
    setSaveState(stored ? 'dirty' : 'idle');
    setHydratedPersistState(stored ? 'saved' : null);
  }, [defaultSystemRole, dirty, draft, draftBaseline, editable, snapshot]);

  // Debounced / pagehide / unmount persistence — never O(draft) work on every keystroke.
  const livePersistState = useAdminAgentDraftPersistence({
    dirty,
    draft,
    draftBaseline,
    editable,
  });
  const persistState = livePersistState ?? hydratedPersistState;

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
    setDraft(toDraft(snapshot, defaultSystemRole));
    setDirty(false);
    setConflict(false);
    setSaveState('idle');
    setHydratedPersistState(null);
  }, [defaultSystemRole, snapshot]);

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
    setHydratedPersistState(null);
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
