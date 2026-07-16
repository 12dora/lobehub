import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

export const MANAGED_RESOURCE_LOCAL_DRAFT_KEY = 'aihub.admin.managedResources.draft';

export interface ManagedResourceLocalDraft {
  baseRevision: number;
  draft: ManagedResourcePolicyMap;
  draftToken: string;
  original: ManagedResourcePolicyMap;
  savedAt: string;
}

const isPolicyMap = (value: unknown): value is ManagedResourcePolicyMap => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return MANAGED_RESOURCE_KINDS.every((resource) => {
    const item = record[resource];
    if (!item || typeof item !== 'object') return false;
    const policy = item as Record<string, unknown>;
    return (
      typeof policy.managed === 'boolean' &&
      (policy.enforcementMode === 'observe' ||
        policy.enforcementMode === 'ui-only' ||
        policy.enforcementMode === 'enforced')
    );
  });
};

export const loadManagedResourceLocalDraft = (): ManagedResourceLocalDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MANAGED_RESOURCE_LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedResourceLocalDraft>;
    if (
      typeof parsed.baseRevision !== 'number' ||
      typeof parsed.draftToken !== 'string' ||
      typeof parsed.savedAt !== 'string' ||
      !isPolicyMap(parsed.draft) ||
      !isPolicyMap(parsed.original)
    ) {
      return null;
    }
    return parsed as ManagedResourceLocalDraft;
  } catch {
    return null;
  }
};

export const saveManagedResourceLocalDraft = (payload: ManagedResourceLocalDraft) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MANAGED_RESOURCE_LOCAL_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort crash recovery; the editor still retains the in-memory draft.
  }
};

export const clearManagedResourceLocalDraft = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(MANAGED_RESOURCE_LOCAL_DRAFT_KEY);
  } catch {
    // Best effort.
  }
};
