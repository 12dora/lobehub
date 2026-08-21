import { mutate } from '@/libs/swr';

/**
 * Drop cached pages of a paginated memory list.
 *
 * A write invalidates *all* of the list's pages, not just the one on screen.
 * Matcher-based `mutate` with `revalidate: true` would only re-request the keys
 * that currently have a subscriber and hand every other entry straight back
 * from cache, so the pages the user scrolled past would resurrect the row that
 * was just deleted the next time the view mounted. Clearing the entries instead
 * makes the next read a real fetch, and the caller is expected to fetch page 1
 * itself rather than hoping a subscriber does it.
 *
 * `keepEpoch` spares the entries belonging to one request epoch. List keys
 * carry their epoch, so every entry from an earlier one is unreachable and
 * would otherwise pile up — one dead page per filter switch for the life of the
 * session.
 */
export const dropMemoryListCache = async (root: string, keepEpoch?: number): Promise<void> => {
  await mutate(
    (key) => {
      if (!Array.isArray(key) || key[0] !== root) return false;
      if (keepEpoch === undefined) return true;

      return (key[1] as { epoch?: number } | undefined)?.epoch !== keepEpoch;
    },
    undefined,
    { revalidate: false },
  );
};

/**
 * Best-effort version of `dropMemoryListCache` for the reset path.
 *
 * Reset only prunes for hygiene — list keys carry their epoch, so entries from
 * an earlier one are already unreachable and this just stops them accumulating.
 * It is fired without being awaited, so a failure (a provider torn down under
 * it, say) must not surface as an unhandled rejection. The post-write refresh
 * still uses the strict version: there, eviction is what stops a scrolled-past
 * page from re-serving a row that was just deleted.
 */
export const pruneMemoryListCache = (root: string, keepEpoch: number): void => {
  void dropMemoryListCache(root, keepEpoch).catch(() => undefined);
};
