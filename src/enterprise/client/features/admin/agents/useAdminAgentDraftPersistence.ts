'use client';

import { useEffect, useRef, useState } from 'react';

import {
  type DraftPersistStatus,
  saveAdminAgentDraft,
  type StoredAdminAgentDraft,
} from './localDraftStorage';
import type { AdminAgentDraft } from './types';
import type { AgentDraftBaseline } from './useAgentEditor';

const PERSIST_DEBOUNCE_MS = 400;

export interface UseAdminAgentDraftPersistenceArgs {
  dirty: boolean;
  draft: AdminAgentDraft | null;
  draftBaseline: AgentDraftBaseline | null;
  editable: boolean;
}

/**
 * Coalesces recovery-draft persistence so rapid keystrokes do not synchronously scan, validate,
 * serialize, and write the full envelope on every change. Flushes the latest draft on trailing
 * debounce, pagehide, and unmount. On Agent-id change, flushes the previous agent's pending
 * payload under its own id rather than discarding it.
 */
export const useAdminAgentDraftPersistence = ({
  dirty,
  draft,
  draftBaseline,
  editable,
}: UseAdminAgentDraftPersistenceArgs): DraftPersistStatus | null => {
  const [persistState, setPersistState] = useState<DraftPersistStatus | null>(null);
  const latestRef = useRef<{
    agentId: string;
    value: StoredAdminAgentDraft;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the agent id currently scheduled so a mid-flight identity change flushes under the old id.
  const agentIdRef = useRef<string | null>(null);

  const flush = (agentId: string, value: StoredAdminAgentDraft) => {
    const status = saveAdminAgentDraft(agentId, value);
    setPersistState(status);
  };

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Flush a pending draft for a specific agent (used on id change / pagehide / unmount). */
  const flushPendingFor = (agentId: string | null) => {
    clearTimer();
    const pending = latestRef.current;
    if (!pending) return;
    if (agentId && pending.agentId !== agentId) return;
    flush(pending.agentId, pending.value);
    latestRef.current = null;
  };

  useEffect(() => {
    if (!editable || !draftBaseline || !draft || !dirty) {
      // Product agent switch is A → null → B (detail SWR drops keepPreviousData, so baseline
      // tears down before B hydrates). Flush when the teardown is an identity change — not when
      // markSaved/discard keep the same agentId (those must drop pending, not resurrect).
      const leavingAgent = agentIdRef.current;
      const stillSameAgent = draftBaseline?.agentId === leavingAgent;
      if (leavingAgent && !stillSameAgent) flushPendingFor(leavingAgent);
      clearTimer();
      latestRef.current = null;
      agentIdRef.current = draftBaseline?.agentId ?? null;
      setPersistState(null);
      return;
    }

    const nextAgentId = draftBaseline.agentId;

    // Direct baseline swap A → B while still dirty (tests / any future keepPreviousData path).
    if (agentIdRef.current && agentIdRef.current !== nextAgentId) {
      flushPendingFor(agentIdRef.current);
      // Do not carry agent A's blocked/too_large status onto agent B.
      setPersistState(null);
    }

    const value: StoredAdminAgentDraft = {
      draft,
      draftToken: draftBaseline.draftToken,
      revision: draftBaseline.revision,
      savedAt: new Date().toISOString(),
    };
    latestRef.current = { agentId: nextAgentId, value };
    agentIdRef.current = nextAgentId;

    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = latestRef.current;
      // Identity isolation: never write agent B's payload under agent A's timer.
      if (!pending || pending.agentId !== agentIdRef.current) return;
      flush(pending.agentId, pending.value);
      // Avoid a later pagehide/unmount flush re-writing the identical payload.
      latestRef.current = null;
    }, PERSIST_DEBOUNCE_MS);

    return clearTimer;
  }, [dirty, draft, draftBaseline, editable]);

  // pagehide + unmount: flush the latest pending value so navigations do not lose recovery state.
  useEffect(() => {
    const flushLatest = () => {
      flushPendingFor(agentIdRef.current);
    };

    const onPageHide = () => flushLatest();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushLatest();
    };
  }, []);

  return persistState;
};
