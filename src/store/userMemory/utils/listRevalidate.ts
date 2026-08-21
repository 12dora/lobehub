import { mutate } from '@/libs/swr';

/**
 * Drop every cached page of a paginated memory list.
 *
 * A write (create / update / delete) invalidates *all* of the list's pages, not
 * just the one on screen. Matcher-based `mutate` with `revalidate: true` would
 * only re-request the keys that currently have a subscriber and hand every
 * other entry straight back from cache, so the pages the user scrolled past
 * would resurrect the row that was just deleted the next time the view mounted.
 * Clearing the entries instead makes the next read a real fetch, and the caller
 * is expected to fetch page 1 itself rather than hoping a subscriber does it.
 */
export const dropMemoryListCache = async (root: string): Promise<void> => {
  await mutate((key) => Array.isArray(key) && key[0] === root, undefined, { revalidate: false });
};
