import type { EditableAiProviderDraft } from './controller';

const STORAGE_PREFIX = 'aihub.admin.ai.provider.public-draft.';

export interface StoredAiProviderPublicDraft {
  baseRevision: number;
  draft: EditableAiProviderDraft;
  draftToken: string;
  savedAt: string;
}

const storageKey = (id: string) => `${STORAGE_PREFIX}${id}`;

/** Persist only public editable fields. Secret values are not accepted by this API. */
export const saveAiProviderPublicDraft = (
  id: string,
  payload: StoredAiProviderPublicDraft,
): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(payload));
  } catch {
    // Local recovery is best effort; server draft remains authoritative.
  }
};

export const loadAiProviderPublicDraft = (id: string): StoredAiProviderPublicDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAiProviderPublicDraft>;
    if (
      typeof parsed.baseRevision !== 'number' ||
      !parsed.draft ||
      typeof parsed.draftToken !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    return parsed as StoredAiProviderPublicDraft;
  } catch {
    return null;
  }
};

export const clearAiProviderPublicDraft = (id: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey(id));
  } catch {
    // Ignore unavailable storage.
  }
};
