/**
 * Fallback page size used when the store has not seen a fetch yet. Mirrors the
 * `hasMore` heuristic the list slices have always used.
 */
export const DEFAULT_MEMORY_LIST_PAGE_SIZE = 20;

/**
 * Stable identity of a memory list query: everything that decides *which* rows
 * belong in the list, and nothing about pagination.
 *
 * Every write into a list is guarded by this string. The lists are paginated
 * and accumulate pages, so a response that belongs to a query the user has
 * already navigated away from must never be appended — that is how a filter
 * switch used to end up with two queries' rows interleaved. `undefined`, `null`,
 * `''` and `[]` all mean "not filtered", so they have to collapse to the same
 * key; array order is not part of the identity either.
 */
export const memoryListQueryKey = (params?: Record<string, unknown>): string => {
  const entries = Object.entries(params ?? {})
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0),
    )
    .map(
      ([key, value]) =>
        [key, Array.isArray(value) ? [...value].map(String).sort() : value] as const,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return JSON.stringify(entries);
};
