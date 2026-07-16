/**
 * Durable local draft persistence for admin settings editor.
 * Keyed by registry version + base revision so stale drafts are not restored after publish.
 */

const PREFIX = 'aihub.admin.settings.draft';

export type LocalDraftPayload = {
  draft: Record<
    string,
    {
      mode: 'user' | 'default' | 'locked';
      schemaVersion: number;
      value?: unknown;
      visibility: 'visible' | 'hidden';
    }
  >;
  registryVersion: number;
  baseRevision: number;
  savedAt: string;
};

export const buildLocalDraftKey = (registryVersion: number, baseRevision: number) =>
  `${PREFIX}:v${registryVersion}:r${baseRevision}`;

export const loadLocalDraft = (
  registryVersion: number,
  baseRevision: number,
): LocalDraftPayload | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(buildLocalDraftKey(registryVersion, baseRevision));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraftPayload;
    if (
      parsed.registryVersion !== registryVersion ||
      parsed.baseRevision !== baseRevision ||
      !parsed.draft
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const saveLocalDraft = (payload: LocalDraftPayload) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      buildLocalDraftKey(payload.registryVersion, payload.baseRevision),
      JSON.stringify(payload),
    );
  } catch {
    /* quota / private mode */
  }
};

export const clearLocalDraft = (registryVersion: number, baseRevision: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(buildLocalDraftKey(registryVersion, baseRevision));
  } catch {
    /* ignore */
  }
};
