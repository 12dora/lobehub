import { unstable_serialize } from 'swr';

import { getScopedCache, mutate } from '@/libs/swr';

/**
 * Delete every cache entry belonging to one list, rather than emptying it.
 *
 * `mutate(key, undefined)` clears an entry's data but leaves the entry in the
 * provider's Map. List keys carry a per-mount epoch, so every filter switch and
 * every remount mints keys nothing will ever read again — blanked entries would
 * pile up for the life of the session. The serialized prefix comes from SWR's
 * own `unstable_serialize` so this does not depend on the hash format.
 */
const deleteMemoryListCacheEntries = (root: string): void => {
  const cache = getScopedCache();
  if (!cache || typeof cache.keys !== 'function' || typeof cache.delete !== 'function') return;

  // `['root']` serializes to the prefix that `['root', params]` starts with.
  const prefix = unstable_serialize([root]);

  for (const key of cache.keys()) {
    if (typeof key === 'string' && key.startsWith(prefix)) cache.delete(key);
  }
};

/**
 * Drop every cached page of a paginated memory list.
 *
 * A write invalidates *all* of the list's pages, not just the one on screen.
 * Matcher-based `mutate` with `revalidate: true` would only re-request the keys
 * that currently have a subscriber and hand every other entry straight back
 * from cache, so the pages the user scrolled past would resurrect the row that
 * was just deleted the next time the view mounted. Blanking the entries first
 * notifies the subscribers; deleting them then reclaims the slots.
 */
export const dropMemoryListCache = async (root: string): Promise<void> => {
  await mutate((key) => Array.isArray(key) && key[0] === root, undefined, { revalidate: false });
  deleteMemoryListCacheEntries(root);
};

/**
 * Best-effort version for the reset path.
 *
 * Reset prunes for hygiene — the request already in flight carries the new
 * epoch and will repopulate its own entry, and the store, not the cache, is
 * what the list renders from. It is fired without being awaited, so a failure
 * (a provider torn down under it, say) must not surface as an unhandled
 * rejection. The post-write refresh keeps the strict version: there, eviction
 * is what stops a scrolled-past page from re-serving a row that was deleted.
 */
export const pruneMemoryListCache = (root: string): void => {
  void dropMemoryListCache(root).catch(() => undefined);
};
