// @vitest-environment happy-dom
import { act, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScopedMutate } from '@/libs/swr';
import { useUserMemoryStore } from '@/store/userMemory';
import { initialState } from '@/store/userMemory/initialState';

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
  deleteIdentity: vi.fn(),
  queryIdentities: vi.fn(),
}));

vi.mock('@/services/userMemory', () => ({
  memoryCRUDService: {
    createIdentity: vi.fn(),
    deleteIdentity: services.deleteIdentity,
    updateIdentity: vi.fn(),
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

/** Mirrors `SWRMutateInitializer`: publishes the scoped mutate for use outside React. */
const MutateBridge = ({ children }: PropsWithChildren) => {
  const { mutate } = useSWRConfig();
  useEffect(() => setScopedMutate(mutate), [mutate]);
  return <>{children}</>;
};

/** The identities page's data wiring, with nothing but the data wiring in it. */
const Reader = ({ q }: { q?: string }) => {
  const page = useUserMemoryStore((s) => s.identitiesPage);
  const useFetchIdentities = useUserMemoryStore((s) => s.useFetchIdentities);
  const resetIdentitiesList = useUserMemoryStore((s) => s.resetIdentitiesList);

  const listQuery = useMemo(() => ({ q }), [q]);

  useEffect(() => {
    resetIdentitiesList(listQuery);
  }, [listQuery, resetIdentitiesList]);

  useFetchIdentities({ ...listQuery, page, pageSize: PAGE_SIZE });

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

const state = () => useUserMemoryStore.getState();
const ids = () => state().identities.map((item) => item.id);

/** Every row id sitting in the SWR cache, whichever page it belongs to. */
const cachedRowIds = () =>
  [...cache.values()].flatMap((entry) =>
    (((entry as { data?: { items?: Row[] } })?.data?.items ?? []) as Row[]).map((item) => item.id),
  );

beforeEach(() => {
  vi.clearAllMocks();
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
