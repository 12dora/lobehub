'use client';

import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { AdminBrandingDraft } from '@/server/enterprise/contracts/adminBranding';

export type BrandingEditorState = 'conflict' | 'dirty' | 'idle' | 'publishing' | 'saving';

interface BrandingEditorStore {
  baseRevision: number;
  draft: AdminBrandingDraft | null;
  draftMatchesPublished: boolean;
  draftToken: string;
  editorState: BrandingEditorState;
  hydrate: (params: {
    baseRevision: number;
    draft: AdminBrandingDraft;
    draftToken: string;
    draftMatchesPublished: boolean;
  }) => void;
  markConflict: () => void;
  patch: (patch: Partial<AdminBrandingDraft>) => void;
  replaceDraft: (draft: AdminBrandingDraft) => void;
  reset: () => void;
  setEditorState: (state: BrandingEditorState) => void;
  syncServer: (params: { baseRevision: number; draftToken: string }) => void;
}

const initialState = {
  baseRevision: 0,
  draft: null,
  draftToken: '',
  draftMatchesPublished: false,
  editorState: 'idle' as const,
};

export const useBrandingEditorStore = createWithEqualityFn<BrandingEditorStore>()(
  (set) => ({
    ...initialState,
    hydrate: (params) => set({ ...params, editorState: 'idle' }),
    markConflict: () => set({ editorState: 'conflict' }),
    patch: (patch) =>
      set((state) => ({
        draft: state.draft ? { ...state.draft, ...patch } : state.draft,
        editorState: state.editorState === 'conflict' ? 'conflict' : 'dirty',
      })),
    replaceDraft: (draft) => set({ draft, editorState: 'dirty' }),
    reset: () => set(initialState),
    setEditorState: (editorState) => set({ editorState }),
    syncServer: ({ baseRevision, draftToken }) =>
      set({ baseRevision, draftMatchesPublished: false, draftToken, editorState: 'idle' }),
  }),
  shallow,
);
