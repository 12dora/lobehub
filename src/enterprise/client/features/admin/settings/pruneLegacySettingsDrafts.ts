/**
 * One-shot cleanup for the localStorage drafts written by the pre-de-draft settings editor.
 *
 * 保存 now applies site-wide immediately, so nothing ever restores these entries again —
 * prune them when the editor mounts so a returning admin does not carry stale local state
 * (and does not keep policy values in localStorage indefinitely).
 */

const LEGACY_DRAFT_PREFIX = 'aihub.admin.settings.draft:';
const LEGACY_CONFLICT_DRAFT_KEY = 'aihub.admin.settings.conflictDraft';

export const pruneLegacyAdminSettingsDrafts = () => {
  if (typeof window === 'undefined') return;
  try {
    const storage = window.localStorage;
    storage.removeItem(LEGACY_CONFLICT_DRAFT_KEY);
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_PREFIX)) storage.removeItem(key);
    }
  } catch {
    /* private mode / quota — nothing to recover */
  }
};
