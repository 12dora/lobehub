'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { EditableSkillDraft } from '../controller';
import {
  saveSkillLocalDraft,
  type SkillDraftPersistenceStatus,
  type StoredSkillDraft,
} from '../localDraftStorage';

const PERSIST_DEBOUNCE_MS = 400;

interface SkillDraftPersistenceInput {
  activeId?: string;
  baseDraft: EditableSkillDraft | null;
  baseDraftSequence?: number;
  baseRevision?: number;
  dirty: boolean;
  draft: EditableSkillDraft | null;
  editable: boolean;
}

interface SkillDraftPersistenceResult {
  markSaved: () => void;
  status: SkillDraftPersistenceStatus;
}

/**
 * Coalesces expensive validation, secret scanning, serialization, and localStorage writes.
 * The latest payload is flushed on the trailing edge, page hide, identity change, and unmount.
 */
export const useSkillDraftPersistence = ({
  activeId,
  baseDraft,
  baseDraftSequence,
  baseRevision,
  dirty,
  draft,
  editable,
}: SkillDraftPersistenceInput): SkillDraftPersistenceResult => {
  const [status, setStatus] = useState<SkillDraftPersistenceStatus>('saved');
  const latestRef = useRef<{ id: string; payload: StoredSkillDraft } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const pending = latestRef.current;
    if (!pending) return;
    latestRef.current = null;
    setStatus(saveSkillLocalDraft(pending.id, pending.payload));
  }, [clearTimer]);

  const markSaved = useCallback(() => {
    clearTimer();
    latestRef.current = null;
    setStatus('saved');
  }, [clearTimer]);

  useEffect(() => {
    if (latestRef.current && latestRef.current.id !== activeId) flush();

    const complete =
      editable &&
      dirty &&
      activeId &&
      baseDraft &&
      draft &&
      baseRevision !== undefined &&
      baseDraftSequence !== undefined;
    if (!complete) {
      clearTimer();
      latestRef.current = null;
      return;
    }

    latestRef.current = {
      id: activeId,
      payload: {
        baseDraft,
        baseDraftSequence,
        baseRevision,
        draft,
        savedAt: new Date().toISOString(),
      },
    };
    clearTimer();
    timerRef.current = setTimeout(flush, PERSIST_DEBOUNCE_MS);

    return clearTimer;
  }, [
    activeId,
    baseDraft,
    baseDraftSequence,
    baseRevision,
    clearTimer,
    dirty,
    draft,
    editable,
    flush,
  ]);

  useEffect(() => {
    const onPageHide = () => flush();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }, [flush]);

  return { markSaved, status };
};
