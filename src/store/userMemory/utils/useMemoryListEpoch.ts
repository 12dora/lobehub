import { useMemo } from 'react';

import { nextMemoryListEpoch } from './listQuery';

/**
 * A fresh request epoch for every instance of a list query.
 *
 * The epoch travels in the SWR key *and* is recorded on the store by the page's
 * reset, which is what makes the two agree without depending on effect order:
 * SWR starts its fetch from a layout effect, before the page's passive reset
 * effect runs, so anything the reset computed afterwards would arrive too late
 * to stamp the request. Deriving it here — during render, next to the key —
 * means the request carries the right epoch from the moment it starts.
 *
 * Putting it in the key also settles the harder half of the problem: returning
 * to a query builds a key nothing has ever fetched, so SWR cannot serve the
 * earlier visit's cached rows and cannot dedupe the new request onto the
 * earlier visit's in-flight one.
 *
 * `listQuery` must be referentially stable per query instance (a `useMemo` over
 * the filters). React may discard and recompute a memo; the worst that does
 * here is mint a new epoch, which costs one extra fetch and stays correct.
 */
export const useMemoryListEpoch = (listQuery: unknown): number =>
  useMemo(() => nextMemoryListEpoch(), [listQuery]);
