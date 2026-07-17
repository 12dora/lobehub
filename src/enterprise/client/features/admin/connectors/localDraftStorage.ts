import type { EditableAdminConnectorDraft } from './controller';

const STORAGE_PREFIX = 'aihub.admin.connectors.draft.';

export interface StoredAdminConnectorDraft {
  baseRevision: number;
  draft: EditableAdminConnectorDraft;
  draftToken: string;
  savedAt: string;
}

const keyFor = (id: string) => `${STORAGE_PREFIX}${id}`;

export const loadAdminConnectorDraft = (id: string): StoredAdminConnectorDraft | null => {
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAdminConnectorDraft;
    if (!parsed.draft || typeof parsed.baseRevision !== 'number' || !parsed.draftToken) {
      localStorage.removeItem(keyFor(id));
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(keyFor(id));
    return null;
  }
};

export const saveAdminConnectorDraft = (id: string, value: StoredAdminConnectorDraft) => {
  localStorage.setItem(keyFor(id), JSON.stringify(value));
};

export const clearAdminConnectorDraft = (id: string) => localStorage.removeItem(keyFor(id));
