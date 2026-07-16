import type { EditableAiProviderDraft } from './controller';

const STORAGE_PREFIX = 'aihub.admin.ai.provider.public-draft.';

export interface StoredAiProviderPublicDraft {
  baseDraft: EditableAiProviderDraft;
  baseRevision: number;
  draft: EditableAiProviderDraft;
  draftToken: string;
  savedAt: string;
}

const storageKey = (id: string) => `${STORAGE_PREFIX}${id}`;

const pickPublicDraft = (draft: Record<string, unknown>): EditableAiProviderDraft | null => {
  if (
    typeof draft.configText !== 'string' ||
    typeof draft.displayName !== 'string' ||
    typeof draft.enabled !== 'boolean' ||
    typeof draft.fetchOnClient !== 'boolean' ||
    typeof draft.settingsText !== 'string' ||
    typeof draft.sort !== 'number'
  ) {
    return null;
  }
  return {
    checkModel: typeof draft.checkModel === 'string' ? draft.checkModel : null,
    configText: draft.configText,
    description: typeof draft.description === 'string' ? draft.description : null,
    displayName: draft.displayName,
    enabled: draft.enabled,
    fetchOnClient: draft.fetchOnClient,
    logo: typeof draft.logo === 'string' ? draft.logo : null,
    settingsText: draft.settingsText,
    sort: draft.sort,
  };
};

const normalizeDraft = (value: unknown): EditableAiProviderDraft | null => {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.configText === 'string' && typeof draft.settingsText === 'string') {
    return pickPublicDraft(draft);
  }
  // Migrate the first M07 UI draft shape without ever accepting Secret metadata.
  if (
    draft.config &&
    typeof draft.config === 'object' &&
    draft.settings &&
    typeof draft.settings === 'object'
  ) {
    const { config, settings, ...fields } = draft;
    return pickPublicDraft({
      ...(fields as unknown as Omit<EditableAiProviderDraft, 'configText' | 'settingsText'>),
      configText: JSON.stringify(config, null, 2),
      settingsText: JSON.stringify(settings, null, 2),
    });
  }
  return null;
};

/** Persist only public editable fields. Secret values are not accepted by this API. */
export const saveAiProviderPublicDraft = (
  id: string,
  payload: StoredAiProviderPublicDraft,
): void => {
  if (typeof window === 'undefined') return;
  try {
    const baseDraft = pickPublicDraft(payload.baseDraft as unknown as Record<string, unknown>);
    const draft = pickPublicDraft(payload.draft as unknown as Record<string, unknown>);
    if (!baseDraft || !draft) return;
    window.localStorage.setItem(
      storageKey(id),
      JSON.stringify({
        baseDraft,
        baseRevision: payload.baseRevision,
        draft,
        draftToken: payload.draftToken,
        savedAt: payload.savedAt,
      } satisfies StoredAiProviderPublicDraft),
    );
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
    const draft = normalizeDraft(parsed.draft);
    if (
      typeof parsed.baseRevision !== 'number' ||
      !draft ||
      typeof parsed.draftToken !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    return {
      baseDraft: normalizeDraft(parsed.baseDraft) ?? structuredClone(draft),
      baseRevision: parsed.baseRevision,
      draft,
      draftToken: parsed.draftToken,
      savedAt: parsed.savedAt,
    };
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
