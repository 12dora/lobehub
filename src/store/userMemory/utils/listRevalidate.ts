import { mutate } from '@/libs/swr';

/**
 * Revalidate every cached page of a paginated memory list.
 *
 * The list SWR keys are `[root, params]`, and `params` carries the page — so a
 * write (create / update / delete) cannot be flushed by touching a single key,
 * and it cannot rely on the reset action either: `reset*List` deliberately
 * no-ops when the query is unchanged (that no-op is what stops a remount from
 * wiping already-loaded rows). Matching on the key root revalidates whatever
 * pages the cache is holding for this list, whichever filter they belong to.
 */
export const revalidateMemoryList = async (root: string): Promise<void> => {
  await mutate((key) => Array.isArray(key) && key[0] === root);
};
