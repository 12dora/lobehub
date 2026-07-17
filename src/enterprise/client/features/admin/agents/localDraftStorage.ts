import type { AdminAgentDraft } from './types';

const STORAGE_PREFIX = 'aihub.admin.agents.draft.';

export interface StoredAdminAgentDraft {
  draft: AdminAgentDraft;
  draftToken: string;
  revision: number;
  savedAt: string;
}

const keyFor = (id: string) => `${STORAGE_PREFIX}${id}`;

export const loadAdminAgentDraft = (id: string): StoredAdminAgentDraft | null => {
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredAdminAgentDraft;
    if (!value.draft?.config || !value.draft?.dependencySnapshot || !value.draftToken) {
      localStorage.removeItem(keyFor(id));
      return null;
    }
    return value;
  } catch {
    localStorage.removeItem(keyFor(id));
    return null;
  }
};

export const saveAdminAgentDraft = (id: string, value: StoredAdminAgentDraft) => {
  localStorage.setItem(keyFor(id), JSON.stringify(value));
};

export const clearAdminAgentDraft = (id: string) => localStorage.removeItem(keyFor(id));
