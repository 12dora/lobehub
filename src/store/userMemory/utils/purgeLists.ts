/**
 * The five paginated memory lists, by the prefix every one of their state
 * fields is spelled with.
 */
const MEMORY_LISTS = [
  'activities',
  'contexts',
  'experiences',
  'identities',
  'preferences',
] as const;

/**
 * The part of a list's state that says *which* rows belong on screen. A purge
 * empties the list; it does not move the page to a different query.
 */
const QUERY_IDENTITY_FIELDS = [
  'PageSize',
  'Query',
  'QueryKey',
  'Relationships',
  'Sort',
  'Status',
  'Types',
] as const;

/**
 * The store draft, addressed by the generated field names above. The slice
 * states are structurally identical per list but have no common TypeScript
 * shape, so this one helper reads them dynamically instead of five near-copies
 * doing it by hand.
 */
type ListDraft = Record<string, unknown>;

export type MemoryListQuerySnapshot = Record<string, unknown>;

/** Read every list's query identity before the slices are reset. */
export const captureMemoryListQueries = (draft: ListDraft): MemoryListQuerySnapshot => {
  const snapshot: MemoryListQuerySnapshot = {};

  for (const list of MEMORY_LISTS) {
    for (const field of QUERY_IDENTITY_FIELDS) {
      snapshot[`${list}${field}`] = draft[`${list}${field}`];
    }

    snapshot[`${list}Generation`] = draft[`${list}Generation`];
  }

  return snapshot;
};

/**
 * Put each list back on the query its page is showing, settled and empty.
 *
 * Purging resets the slices to their initial state, which blanks the query
 * identity too. A page that is already mounted does not re-run its reset effect
 * for that (its own filters didn't change), so the store and the page disagreed
 * about which query was on screen: the purge's revalidation came back with an
 * empty page that no longer matched the store's identity, was rejected, and the
 * list sat on its skeleton forever. Restoring the identity — and declaring it
 * settled, because "no memories at all" is a resolved answer — leaves the
 * mounted page showing its empty state, and a later visit still hits the
 * unchanged-query no-op instead of re-blanking.
 */
export const restoreMemoryListQueries = (
  draft: ListDraft,
  snapshot: MemoryListQuerySnapshot,
): void => {
  for (const list of MEMORY_LISTS) {
    for (const field of QUERY_IDENTITY_FIELDS) {
      draft[`${list}${field}`] = snapshot[`${list}${field}`];
    }

    // Anything still in flight predates the purge.
    draft[`${list}Generation`] = ((snapshot[`${list}Generation`] as number) ?? 0) + 1;
    draft[`${list}HasMore`] = false;
    draft[`${list}Settled`] = true;
  }
};
