'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { AdminBrandingGetOutput } from '@/enterprise/client/services/adminBranding';

import { hasBrandingChanges, useBrandingEditorStore } from './store';

export interface UseBrandingHydrationResult {
  noteObservedSnapshot: (revision: number, token: string) => void;
}

export const useBrandingHydration = (
  data: AdminBrandingGetOutput | undefined,
): UseBrandingHydrationResult => {
  const { adopt, baseline, branding, editorState, markConflict, reset, revision, token } =
    useBrandingEditorStore();
  const observedServerSnapshot = useRef<string | null>(null);
  const changed = hasBrandingChanges(branding, baseline);

  useEffect(() => {
    if (!data) return;
    const snapshotKey = `${data.revision}:${data.token}`;
    // After unmount/StrictMode cleanup the store is reset while this ref can still hold the
    // same snapshot key. Always rehydrate when the form is empty so inputs refill.
    if (!branding) {
      observedServerSnapshot.current = snapshotKey;
      adopt(data);
      return;
    }
    if (observedServerSnapshot.current === snapshotKey) return;
    observedServerSnapshot.current = snapshotKey;
    if (data.token === token && data.revision === revision) return;
    // Revisions only ever move forward: a fulfilled read that is older than what we already
    // hold is a stale cache, never an authority to roll the editor back.
    if (data.revision < revision) return;
    // Someone else saved. An editor with nothing of its own simply follows; unsaved edits and
    // in-flight saves are never overwritten.
    if (!changed && editorState !== 'saving') adopt(data);
    else if (editorState !== 'conflict') markConflict(data.revision);
  }, [adopt, branding, changed, data, editorState, markConflict, revision, token]);

  useEffect(
    () => () => {
      // Clear observation so a remount with the same SWR snapshot can hydrate again
      // even if the module-level store was already emptied by reset().
      observedServerSnapshot.current = null;
      reset();
    },
    [reset],
  );

  const noteObservedSnapshot = useCallback((nextRevision: number, nextToken: string) => {
    observedServerSnapshot.current = `${nextRevision}:${nextToken}`;
  }, []);

  return { noteObservedSnapshot };
};
