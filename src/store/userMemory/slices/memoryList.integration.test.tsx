// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScopedCache, setScopedMutate } from '@/libs/swr';
import { useUserMemoryStore } from '@/store/userMemory';
import { initialState } from '@/store/userMemory/initialState';
import { useMemoryListEpoch } from '@/store/userMemory/utils/useMemoryListEpoch';
import { LayersEnum } from '@/types/userMemory';

/**
 * Runs against a REAL SWR cache — `@/libs/swr` is deliberately NOT mocked.
 *
 * Everything these tests protect is invisible to a mocked `mutate`: whether a
 * post-write refresh actually re-reads page 1 (rather than whichever page the
 * subscriber happens to sit on), whether an evicted page can resurrect a
 * deleted row on the next render, and whether a response that belongs to an
 * abandoned query can still be appended to the list. Asserting "mutate was
 * called with a predicate" passes in every one of those cases.
 */
const services = vi.hoisted(() => ({
  deleteAll: vi.fn(),
  deleteIdentity: vi.fn(),
  queryIdentities: vi.fn(),
  updateIdentity: vi.fn(),
}));

vi.mock('@/services/userMemory', () => ({
  memoryCRUDService: {
    createIdentity: vi.fn(),
    deleteAll: services.deleteAll,
    deleteIdentity: services.deleteIdentity,
    updateIdentity: services.updateIdentity,
  },
  userMemoryService: { queryIdentities: services.queryIdentities },
}));

interface Row {
  id: string;
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

/** A promise the test resolves by hand, so "in flight" is an observable state. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const PAGE_SIZE = 2;

let cache: Map<unknown, unknown>;
let setQuery!: (q: string | undefined) => void;

/** Mirrors `SWRMutateInitializer`: publishes the scoped mutate and cache. */
const MutateBridge = ({ children }: PropsWithChildren) => {
  const { cache, mutate } = useSWRConfig();
  useEffect(() => setScopedMutate(mutate), [mutate]);
  useEffect(() => setScopedCache(cache), [cache]);
  return <>{children}</>;
};

/** SWR's `mutate` for the key the reader is currently on — the page's Retry. */
let revalidateCurrentPage!: () => Promise<unknown>;

/** The identities page's data wiring, with nothing but the data wiring in it. */
const Reader = ({ q }: { q?: string }) => {
  const page = useUserMemoryStore((s) => s.identitiesPage);
  const useFetchIdentities = useUserMemoryStore((s) => s.useFetchIdentities);
  const resetIdentitiesList = useUserMemoryStore((s) => s.resetIdentitiesList);

  const listQuery = useMemo(() => ({ q }), [q]);
  const epoch = useMemoryListEpoch(listQuery);

  useEffect(() => {
    resetIdentitiesList(listQuery, epoch);
  }, [epoch, listQuery, resetIdentitiesList]);

  const swr = useFetchIdentities({ ...listQuery, epoch, page, pageSize: PAGE_SIZE });
  revalidateCurrentPage = swr.mutate;

  return null;
};

const Host = () => {
  const [q, setQ] = useState<string | undefined>();
  setQuery = setQ;
  return <Reader q={q} />;
};

const mountApp = () =>
  render(
    <SWRConfig value={{ provider: () => cache as unknown as Cache }}>
      <MutateBridge>
        <Host />
      </MutateBridge>
    </SWRConfig>,
  );

/**
 * The provider without a reader, for the cases that are purely about the store:
 * `dropMemoryListCache` still needs the scoped mutate, but a mounted list would
 * fire fetches of its own and make request ordering ambiguous.
 */
const mountCacheOnly = () =>
  render(
    <SWRConfig value={{ provider: () => cache as unknown as Cache }}>
      <MutateBridge />
    </SWRConfig>,
  );

const state = () => useUserMemoryStore.getState();
const ids = () => state().identities.map((item) => item.id);

/** Every row id sitting in the SWR cache, whichever page it belongs to. */
const cachedRowIds = () =>
  [...cache.values()].flatMap((entry) =>
    (((entry as { data?: { items?: Row[] } })?.data?.items ?? []) as Row[]).map((item) => item.id),
  );

/** Every cache entry belonging to the identity list. */
const listCacheKeys = () =>
  [...cache.keys()].filter((key) => String(key).includes('userMemory:identityList'));

/** Load pages 1..n of the default query, two rows each. */
const loadPages = async (...pages: string[][]) => {
  services.queryIdentities.mockResolvedValue({ items: rows(...pages[0]), total: 10 });
  const app = mountApp();
  await waitFor(() => expect(ids()).toEqual(pages[0]));

  for (const page of pages.slice(1)) {
    services.queryIdentities.mockResolvedValue({ items: rows(...page), total: 10 });
    act(() => state().loadMoreIdentities());
    await waitFor(() => expect(ids()).toContain(page[0]));
  }

  return app;
};

beforeEach(() => {
  // Each test mounts its own provider; a tree left over from the previous one
  // would keep subscribing to the same store and answer its fetches.
  cleanup();
  vi.clearAllMocks();
  services.queryIdentities.mockReset();
  services.deleteAll.mockResolvedValue(undefined);
  services.deleteIdentity.mockResolvedValue(undefined);
  services.updateIdentity.mockResolvedValue(true);
  cache = new Map();
  useUserMemoryStore.setState({ ...initialState }, false);
});

describe('memory list pagination against a real SWR cache', () => {
  it('cannot append the next query onto the previous query rows when the user is near the end', async () => {
    // Query A: one full page, more to come.
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 10 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));
    expect(state().identitiesHasMore).toBe(true);

    // Query B's page 1 is still in flight …
    const pending = deferred<{ items: Row[]; total: number }>();
    services.queryIdentities.mockReturnValue(pending.promise);
    act(() => setQuery('b'));

    // … and the virtualized list hits `endReached` while it is.
    act(() => state().loadMoreIdentities());

    // The rows on screen still belong to A, so page 2 must not be requested:
    // it would be page 2 *of B* appended onto A's rows, leaving the list
    // permanently mixed with B's page 1 missing.
    expect(state().identitiesPage).toBe(1);
    expect(state().identitiesHasMore).toBe(false);
    expect(ids()).toEqual(['a1', 'a2']);

    await act(async () => {
      pending.resolve({ items: rows('b1', 'b2'), total: 10 });
      await pending.promise;
    });

    await waitFor(() => expect(ids()).toEqual(['b1', 'b2']));
    expect(state().identitiesPage).toBe(1);
    expect(state().identitiesSettled).toBe(true);
  });

  it('accumulates pages normally once the query has settled', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 10 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));

    services.queryIdentities.mockResolvedValue({ items: rows('a3', 'a4'), total: 10 });
    act(() => state().loadMoreIdentities());

    await waitFor(() => expect(ids()).toEqual(['a1', 'a2', 'a3', 'a4']));
    expect(state().identitiesPage).toBe(2);
  });

  it('re-reads page 1 after a delete made from page 3, and never re-serves the deleted row', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 10 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));

    services.queryIdentities.mockResolvedValue({ items: rows('a3', 'a4'), total: 10 });
    act(() => state().loadMoreIdentities());
    await waitFor(() => expect(ids()).toHaveLength(4));

    services.queryIdentities.mockResolvedValue({ items: rows('a5', 'a6'), total: 10 });
    act(() => state().loadMoreIdentities());
    await waitFor(() => expect(ids()).toHaveLength(6));
    expect(state().identitiesPage).toBe(3);

    // a1 is gone server-side now.
    services.deleteIdentity.mockResolvedValue(undefined);
    services.queryIdentities.mockResolvedValue({ items: rows('a2', 'a3'), total: 9 });
    services.queryIdentities.mockClear();

    await act(async () => {
      await state().deleteIdentity('a1');
    });

    // The refresh must fetch page 1 explicitly. Revalidating "whatever is
    // subscribed" re-reads page 3 instead — page 1 and 2 have no subscriber at
    // that moment, so `mutate` hands their stale entries straight back and the
    // deleted row reappears as soon as the store rewinds to page 1.
    expect(services.queryIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: PAGE_SIZE }),
    );

    // Awaiting the delete is enough: the store is authoritative by then, with
    // no intermediate frame that re-serves a1 from a cached page.
    expect(state().identitiesPage).toBe(1);
    expect(ids()).toEqual(['a2', 'a3']);
    expect(state().identitiesTotal).toBe(9);

    // Every page of the list is invalidated, not just the subscribed one. A
    // matcher-based `mutate` hands the unsubscribed pages 2 and 3 straight back
    // from cache, so scrolling down again would re-serve the pre-delete slice;
    // a4–a6 only ever lived in those two entries.
    const stillCached = cachedRowIds();
    expect(stillCached).not.toContain('a4');
    expect(stillCached).not.toContain('a5');
    expect(stillCached).not.toContain('a6');

    // Let every subscriber settle: the deleted row stays gone.
    await act(async () => {
      await Promise.resolve();
    });
    expect(ids()).not.toContain('a1');
  });
});

describe('memory list failures', () => {
  it('surfaces a cold failure instead of leaving the skeleton up forever', async () => {
    services.queryIdentities.mockRejectedValue(new Error('boom'));
    mountApp();

    await waitFor(() => expect(state().identitiesError).toBeInstanceOf(Error));

    // What the page reads to decide skeleton vs. error vs. list.
    expect(state().identitiesSettled).toBe(false);
    expect(state().identitiesSearchLoading).toBe(false);
    expect(state().identities).toHaveLength(0);
  });

  it('surfaces a failed filter change instead of passing off the old rows as the new results', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 2 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));

    services.queryIdentities.mockRejectedValue(new Error('nope'));
    act(() => setQuery('b'));

    await waitFor(() => expect(state().identitiesError).toBeInstanceOf(Error));
    // The rows are still A's, and `settled` is false — so the page renders the
    // failure with a Retry rather than presenting them as results for "b".
    expect(ids()).toEqual(['a1', 'a2']);
    expect(state().identitiesSettled).toBe(false);
  });

  it('clears the failure once the query succeeds again', async () => {
    services.queryIdentities.mockRejectedValue(new Error('boom'));
    mountApp();
    await waitFor(() => expect(state().identitiesError).toBeInstanceOf(Error));

    services.queryIdentities.mockResolvedValue({ items: rows('a1'), total: 1 });
    act(() => setQuery('b'));

    await waitFor(() => expect(ids()).toEqual(['a1']));
    expect(state().identitiesError).toBeUndefined();
    expect(state().identitiesSettled).toBe(true);
  });
});

describe('memory list writes from outside the list', () => {
  it('re-reads page 1 when the editor edits a row out of the query, from page 3', async () => {
    await loadPages(['a1', 'a2'], ['a3', 'a4'], ['a5', 'a6']);
    expect(state().identitiesPage).toBe(3);

    // a1 is edited so it no longer matches the query it was listed under.
    services.queryIdentities.mockResolvedValue({ items: rows('a2', 'a3'), total: 9 });
    services.queryIdentities.mockClear();

    await act(async () => {
      await state().updateMemory('a1', 'edited', LayersEnum.Identity);
    });

    // The editor lives in the base slice and used to invalidate with a bare
    // matcher `mutate`: only page 3 revalidated, so the edited row stayed in
    // the accumulated list and pages 1–2 stayed stale in the cache.
    expect(services.updateIdentity).toHaveBeenCalledWith('a1', { description: 'edited' });
    expect(services.queryIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: PAGE_SIZE }),
    );
    expect(state().identitiesPage).toBe(1);
    expect(ids()).toEqual(['a2', 'a3']);

    const stillCached = cachedRowIds();
    expect(stillCached).not.toContain('a4');
    expect(stillCached).not.toContain('a6');
  });

  it('leaves a filtered list mounted on its own query after a purge', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 2 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));

    act(() => setQuery('b'));
    await waitFor(() => expect(state().identitiesSettled).toBe(true));
    const filteredQueryKey = state().identitiesQueryKey;

    services.queryIdentities.mockResolvedValue({ items: [], total: 0 });
    await act(async () => {
      await state().purgeAllMemories();
    });

    // The mounted page does not re-run its reset effect for a purge — its own
    // filters didn't change — so blanking the store's query identity left the
    // two disagreeing: the purge's revalidation came back as "page 1 of no
    // query", was rejected, and the list sat on a skeleton it could not leave.
    expect(state().identitiesQueryKey).toBe(filteredQueryKey);
    expect(state().identities).toHaveLength(0);
    expect(state().identitiesTotal).toBe(0);

    // What the page reads: settled with no rows is the empty state, not a
    // skeleton, and not an error.
    expect(state().identitiesSettled).toBe(true);
    expect(state().identitiesError).toBeUndefined();
    expect(state().identitiesHasMore).toBe(false);

    // And a later visit to the same filter still takes the unchanged-query
    // no-op rather than blanking the list again.
    act(() => state().resetIdentitiesList({ q: 'b' }));
    expect(state().identitiesSettled).toBe(true);
  });

  it('drops the older of two overlapping refreshes, whichever lands last', async () => {
    mountCacheOnly();

    // A settled list of three rows, with no reader competing for the mock.
    state().resetIdentitiesList({});
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'b1', 'c1'), total: 3 });
    await act(async () => {
      await state().refreshIdentitiesList();
    });
    expect(ids()).toEqual(['a1', 'b1', 'c1']);

    // Hand every refetch its own hand-controlled promise, in call order.
    const pending: ReturnType<typeof deferred<{ items: Row[]; total: number }>>[] = [];
    services.queryIdentities.mockImplementation(() => {
      const next = deferred<{ items: Row[]; total: number }>();
      pending.push(next);
      return next.promise;
    });

    // Delete a1; its refresh is in flight when b1 is deleted too.
    const firstDelete = state().deleteIdentity('a1');
    await waitFor(() => expect(pending).toHaveLength(1));
    const secondDelete = state().deleteIdentity('b1');
    await waitFor(() => expect(pending).toHaveLength(2));

    // The newer refresh answers first, with both rows gone.
    pending[1].resolve({ items: rows('c1'), total: 1 });
    await waitFor(() => expect(ids()).toEqual(['c1']));

    // The older one lands last, still carrying b1 — it was read before b1 was
    // deleted. Both are "page 1 of this query", so key and page cannot tell
    // them apart; only the generation can, and without it b1 comes back.
    pending[0].resolve({ items: rows('b1', 'c1'), total: 2 });
    await Promise.all([firstDelete, secondDelete]);

    expect(ids()).toEqual(['c1']);
    expect(state().identitiesTotal).toBe(1);
  });

  it('ignores a failure from a refresh that has already been superseded', async () => {
    mountCacheOnly();

    state().resetIdentitiesList({});
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'b1'), total: 2 });
    await act(async () => {
      await state().refreshIdentitiesList();
    });

    const pending: ReturnType<typeof deferred<{ items: Row[]; total: number }>>[] = [];
    services.queryIdentities.mockImplementation(() => {
      const next = deferred<{ items: Row[]; total: number }>();
      pending.push(next);
      return next.promise;
    });

    const firstDelete = state().deleteIdentity('a1');
    await waitFor(() => expect(pending).toHaveLength(1));
    const secondDelete = state().deleteIdentity('b1');
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1].resolve({ items: [], total: 0 });
    await waitFor(() => expect(state().identitiesSettled).toBe(true));

    // The superseded refresh fails on its way back. Its error describes a
    // request nobody is waiting for any more, so surfacing it would replace a
    // perfectly good empty list with a failure the user cannot act on.
    pending[0].reject(new Error('too late'));
    await Promise.all([firstDelete, secondDelete]);

    expect(state().identitiesError).toBeUndefined();
    expect(state().identitiesSettled).toBe(true);
    expect(ids()).toEqual([]);
  });
});

describe('memory list pagination failures', () => {
  it('refuses a second load-more while a page request is still outstanding', async () => {
    await loadPages(['a1', 'a2']);

    const pending = deferred<{ items: Row[]; total: number }>();
    services.queryIdentities.mockReturnValue(pending.promise);

    act(() => state().loadMoreIdentities());
    expect(state().identitiesPage).toBe(2);
    expect(state().identitiesPendingPage).toBe(2);

    // Remounting the virtualizer (grid <-> timeline) lands the viewport at the
    // end again and fires `endReached` a second time. Skipping to page 3 here
    // loses page 2 for good: it is rejected by the page guard when it lands.
    act(() => state().loadMoreIdentities());
    expect(state().identitiesPage).toBe(2);

    await act(async () => {
      pending.resolve({ items: rows('a3', 'a4'), total: 10 });
      await pending.promise;
    });

    await waitFor(() => expect(ids()).toEqual(['a1', 'a2', 'a3', 'a4']));
    expect(state().identitiesPendingPage).toBeUndefined();
  });

  it('surfaces a load-more failure as a retryable footer and retries the same page', async () => {
    await loadPages(['a1', 'a2']);

    services.queryIdentities.mockRejectedValue(new Error('page 2 died'));
    act(() => state().loadMoreIdentities());

    await waitFor(() => expect(state().identitiesPageError).toBeInstanceOf(Error));

    // A pagination failure is not a whole-list failure: the rows stay, the list
    // stays settled, and the page renders a retry footer instead of silently
    // truncating the list at page 1.
    expect(ids()).toEqual(['a1', 'a2']);
    expect(state().identitiesSettled).toBe(true);
    expect(state().identitiesError).toBeUndefined();

    // Nothing may quietly ask for page 3 in the meantime.
    act(() => state().loadMoreIdentities());
    expect(state().identitiesPage).toBe(2);

    services.queryIdentities.mockResolvedValue({ items: rows('a3', 'a4'), total: 10 });
    await act(async () => {
      state().retryIdentitiesPage();
      await revalidateCurrentPage();
    });

    // The retry re-requested page 2 — the page that failed — not page 3.
    expect(services.queryIdentities).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2', 'a3', 'a4']));
    expect(state().identitiesPageError).toBeUndefined();
  });
});

describe('memory list requests that outlive their query', () => {
  it('ignores the first visit to a query when the user has been away and come back', async () => {
    // Every fetch gets a promise the test resolves by hand, in call order.
    const pending: ReturnType<typeof deferred<{ items: Row[]; total: number }>>[] = [];
    services.queryIdentities.mockImplementation(() => {
      const next = deferred<{ items: Row[]; total: number }>();
      pending.push(next);
      return next.promise;
    });

    // Visit A. Its request stalls — the snapshot it is holding is about to go
    // out of date.
    mountApp();
    await waitFor(() => expect(pending).toHaveLength(1));

    // Away to B, where memories change.
    act(() => setQuery('b'));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].resolve({ items: rows('b1'), total: 1 });
      await pending[1].promise;
    });
    await waitFor(() => expect(ids()).toEqual(['b1']));

    // Back to A. This has to be a *new* request: the key carries the epoch, so
    // SWR can neither serve the first visit's cache nor dedupe onto its
    // still-running fetch.
    act(() => setQuery(undefined));
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2].resolve({ items: rows('a9'), total: 1 });
      await pending[2].promise;
    });
    await waitFor(() => expect(ids()).toEqual(['a9']));

    // Only now does the first visit's request answer, with rows read before B
    // was ever opened. A counter that restarted per query would have handed the
    // returned-to list the very tuple this response is stamped with.
    await act(async () => {
      pending[0].resolve({ items: rows('a1', 'a2'), total: 2 });
      await pending[0].promise;
    });

    expect(ids()).toEqual(['a9']);
    expect(state().identitiesTotal).toBe(1);
  });

  it('accepts the revalidation a remount of the same query starts', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a2'), total: 2 });
    const app = mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1', 'a2']));

    app.unmount();
    services.queryIdentities.mockResolvedValue({ items: rows('a1', 'a3'), total: 2 });
    mountApp();

    // The remount mints a fresh epoch. Its reset is a no-op for the rows — the
    // query is unchanged — but the store still has to adopt that epoch, or the
    // revalidation the remount just started is a response it will not recognise.
    await waitFor(() => expect(ids()).toEqual(['a1', 'a3']));
  });
});

describe('memory list remounts', () => {
  it('settles a query that was left mid-flight and returned to before it landed', async () => {
    const pending: ReturnType<typeof deferred<{ items: Row[]; total: number }>>[] = [];
    services.queryIdentities.mockImplementation(() => {
      const next = deferred<{ items: Row[]; total: number }>();
      pending.push(next);
      return next.promise;
    });

    // Open a slow page and leave before it has anything to show.
    const app = mountApp();
    await waitFor(() => expect(pending).toHaveLength(1));
    app.unmount();

    // Come straight back. The remount's request is started from SWR's layout
    // effect, before the reset effect runs — so anything the reset stamps onto
    // the list afterwards has to still match what that request captured, or the
    // page waits on a response the store will refuse forever.
    mountApp();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].resolve({ items: rows('a1'), total: 1 });
      await pending[1].promise;
    });

    await waitFor(() => expect(ids()).toEqual(['a1']));
    expect(state().identitiesSettled).toBe(true);
    expect(state().identitiesSearchLoading).toBe(false);
  });

  it('rereads page 1 when a list left on page 3 is revisited', async () => {
    const app = await loadPages(['a1', 'a2'], ['a3', 'a4'], ['a5', 'a6']);
    expect(state().identitiesPage).toBe(3);
    expect(ids()).toHaveLength(6);

    app.unmount();

    // a1 was deleted elsewhere and the list is shorter now.
    services.queryIdentities.mockClear();
    services.queryIdentities.mockResolvedValue({ items: rows('a2', 'a3'), total: 5 });
    mountApp();

    await waitFor(() => expect(ids()).toEqual(['a2', 'a3']));

    // Resuming on page 3 re-read only that page and appended it to pages 1–2 as
    // the last visit left them: a1 would still be listed, and the list could end
    // up longer than the total it reports.
    expect(services.queryIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: PAGE_SIZE }),
    );
    expect(ids()).not.toContain('a1');
    expect(state().identitiesTotal).toBe(5);
    expect(ids().length).toBeLessThanOrEqual(state().identitiesTotal);
  });

  it('will not page while a remount is re-reading page 1', async () => {
    const app = await loadPages(['a1', 'a2'], ['a3', 'a4']);
    expect(state().identitiesPage).toBe(2);
    expect(state().identitiesHasMore).toBe(true);

    app.unmount();

    const pending = deferred<{ items: Row[]; total: number }>();
    services.queryIdentities.mockImplementation(() => pending.promise);
    mountApp();
    await waitFor(() => expect(state().identitiesPage).toBe(1));

    // The four rows from the last visit are still on screen, so the virtualizer
    // sits at the bottom of them and fires `endReached` while page 1 is out.
    act(() => state().loadMoreIdentities());

    // Advancing here asks for page 2 of a list that is being rebuilt: page 1
    // then loses the page guard and page 2 is appended to rows the server has
    // already moved past.
    expect(state().identitiesPage).toBe(1);

    await act(async () => {
      pending.resolve({ items: rows('a9', 'a8'), total: 4 });
      await pending.promise;
    });

    await waitFor(() => expect(ids()).toEqual(['a9', 'a8']));
    expect(state().identitiesHasMore).toBe(true);
  });

  it('offers a retry when the remount revalidation fails, instead of freezing the list', async () => {
    const app = await loadPages(['a1', 'a2'], ['a3', 'a4']);
    app.unmount();

    services.queryIdentities.mockRejectedValue(new Error('offline'));
    mountApp();

    await waitFor(() => expect(state().identitiesPageError).toBeInstanceOf(Error));

    // The rows are still readable, so this is not a whole-list failure — but
    // pagination is latched off by the rewind, and without a retry there would
    // be nothing left to unlatch it.
    expect(ids()).toHaveLength(4);
    expect(state().identitiesSettled).toBe(true);
    expect(state().identitiesError).toBeUndefined();
  });

  it('does not accumulate cache entries as the list is refiltered', async () => {
    services.queryIdentities.mockResolvedValue({ items: rows('a1'), total: 1 });
    mountApp();
    await waitFor(() => expect(ids()).toEqual(['a1']));

    for (let index = 0; index < 6; index += 1) {
      act(() => setQuery(`q${index}`));
      await waitFor(() => expect(services.queryIdentities).toHaveBeenCalledTimes(index + 2));
    }

    // List keys carry a per-mount epoch, so every filter switch mints one that
    // is never read again. `mutate(key, undefined)` only blanks an entry — the
    // key itself has to be deleted from the provider or they pile up for the
    // life of the session.
    await waitFor(() => expect(listCacheKeys().length).toBeLessThanOrEqual(2));
  });
});
