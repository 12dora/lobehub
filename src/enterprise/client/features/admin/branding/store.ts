'use client';

import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { AdminBrandingPayload } from '@/enterprise/client/services/adminBranding';

export type BrandingEditorState = 'conflict' | 'dirty' | 'idle' | 'saving';

/** Server values plus the CAS pair they were read or written with. */
export interface BrandingSnapshot {
  branding: AdminBrandingPayload;
  revision: number;
  token: string;
}

interface BrandingEditorStore {
  /**
   * The single entry point for server values — reads and save responses alike.
   * Returns false when the snapshot is older than the newest revision already
   * observed, so a delayed response can never roll the editor back.
   */
  adopt: (snapshot: BrandingSnapshot) => boolean;
  /** Last adopted server values — the comparison base for "has real changes". */
  baseline: AdminBrandingPayload | null;
  /** The values shown in the form. */
  branding: AdminBrandingPayload | null;
  editorState: BrandingEditorState;
  markConflict: (observedRevision?: number) => void;
  /** Highest server revision seen, adopted or not — the monotonic guard. */
  observedRevision: number;
  patch: (patch: Partial<AdminBrandingPayload>) => void;
  patchDesktop: (patch: Partial<AdminBrandingPayload['desktop']>) => void;
  reset: () => void;
  revision: number;
  setEditorState: (state: BrandingEditorState) => void;
  token: string;
}

const initialState = {
  baseline: null,
  branding: null,
  editorState: 'idle' as const,
  observedRevision: 0,
  revision: 0,
  token: '',
};

/**
 * Real changes only: an edit that is typed and then undone must not keep the leave guard
 * armed or offer a save that would burn a revision on identical values.
 */
export const hasBrandingChanges = (
  branding: AdminBrandingPayload | null,
  baseline: AdminBrandingPayload | null,
): boolean => {
  if (!branding || !baseline) return false;
  return JSON.stringify(branding) !== JSON.stringify(baseline);
};

/**
 * Edits decide the state from the values themselves: restoring every field to the baseline
 * returns the editor to idle so a newer server snapshot can still be followed.
 * A conflicted editor stays conflicted until the admin reloads the live values.
 */
const applyEdit = (
  state: BrandingEditorStore,
  patch: Partial<AdminBrandingPayload>,
): Partial<BrandingEditorStore> => {
  if (!state.branding) return state;
  const branding = { ...state.branding, ...patch };
  if (state.editorState === 'conflict') return { branding };
  return {
    branding,
    editorState: hasBrandingChanges(branding, state.baseline) ? 'dirty' : 'idle',
  };
};

export const useBrandingEditorStore = createWithEqualityFn<BrandingEditorStore>()(
  (set, get) => ({
    ...initialState,
    adopt: ({ branding, revision, token }) => {
      if (revision < get().observedRevision) return false;
      set({
        baseline: branding,
        branding,
        editorState: 'idle',
        observedRevision: revision,
        revision,
        token,
      });
      return true;
    },
    markConflict: (observedRevision) =>
      set((state) => ({
        editorState: 'conflict',
        observedRevision: Math.max(state.observedRevision, observedRevision ?? 0),
      })),
    patch: (patch) => set((state) => applyEdit(state, patch)),
    patchDesktop: (patch) =>
      set((state) =>
        state.branding
          ? applyEdit(state, { desktop: { ...state.branding.desktop, ...patch } })
          : state,
      ),
    reset: () => set(initialState),
    setEditorState: (editorState) => set({ editorState }),
  }),
  shallow,
);
