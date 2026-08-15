/**
 * One-shot cleanup for the localStorage recovery drafts written by the pre-de-draft Agent editor.
 *
 * 保存 now appends a version and publishes it in one step, so nothing ever restores these entries
 * again — prune them when an admin enters the assistants area so a returning admin does not carry
 * stale local state (and does not keep assistant prompts in localStorage indefinitely).
 *
 * Mirrors `admin/settings/pruneLegacySettingsDrafts.ts`.
 */
import { useEffect } from 'react';

const LEGACY_DRAFT_PREFIX = 'aihub.admin.agents.draft.';

export const pruneLegacyAdminAgentDrafts = () => {
  if (typeof window === 'undefined') return;
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_PREFIX)) storage.removeItem(key);
    }
  } catch {
    /* private mode / quota — nothing to recover */
  }
};

/**
 * Entry-point hook for the admin assistants area. Mounted by BOTH the catalog list and the detail
 * page: a bookmarked / deep-linked detail URL is a first entry too, and it must not leave the old
 * drafts (with their prompts) sitting in localStorage just because the list was never opened.
 */
export const usePruneLegacyAdminAgentDrafts = () => {
  useEffect(() => {
    pruneLegacyAdminAgentDrafts();
  }, []);
};
