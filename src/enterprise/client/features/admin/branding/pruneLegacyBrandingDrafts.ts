/**
 * One-shot cleanup for the localStorage recovery drafts written by the pre-de-draft branding
 * editor.
 *
 * 保存 now writes the live values in one step, so nothing ever restores these entries again —
 * prune them when the page mounts so a returning admin does not carry stale local state (and
 * does not keep branding values in localStorage indefinitely).
 *
 * Mirrors `admin/settings/pruneLegacySettingsDrafts.ts`.
 */
import { useEffect } from 'react';

const LEGACY_DRAFT_PREFIX = 'aihub.admin.branding.draft';

export const pruneLegacyBrandingDrafts = () => {
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

export const usePruneLegacyBrandingDrafts = () => {
  useEffect(() => {
    pruneLegacyBrandingDrafts();
  }, []);
};
