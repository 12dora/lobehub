import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserMemoryStore } from '@/store/userMemory';
import { initialState } from '@/store/userMemory/initialState';

import { memoryListQueryKey } from '../utils/listQuery';

vi.mock('@/services/userMemory', () => ({
  memoryCRUDService: {},
  userMemoryService: {},
}));

/** The reset guard only cares about row *count*, never row shape. */
const stubRows = () => [{ id: 'row-1' }] as unknown as never[];

/**
 * The five memory list slices are the same slice five times over. Table-drive
 * the shared contract so a new one can't quietly ship without the guards, and
 * list every filter field so a query identity that forgets one is caught.
 */
const lists = [
  {
    fields: { q: 'design', sort: 'startsAt', status: ['done'], types: ['task'] },
    key: 'activities',
    loadMore: 'loadMoreActivities',
    reset: 'resetActivitiesList',
    retryPage: 'retryActivitiesPage',
  },
  {
    fields: { q: 'design', sort: 'scoreImpact' },
    key: 'contexts',
    loadMore: 'loadMoreContexts',
    reset: 'resetContextsList',
    retryPage: 'retryContextsPage',
  },
  {
    fields: { q: 'design', sort: 'scoreConfidence' },
    key: 'experiences',
    loadMore: 'loadMoreExperiences',
    reset: 'resetExperiencesList',
    retryPage: 'retryExperiencesPage',
  },
  {
    fields: { q: 'design', relationships: ['peer'], sort: 'type', types: ['personal'] },
    key: 'identities',
    loadMore: 'loadMoreIdentities',
    reset: 'resetIdentitiesList',
    retryPage: 'retryIdentitiesPage',
  },
  {
    fields: { q: 'design', sort: 'scorePriority' },
    key: 'preferences',
    loadMore: 'loadMorePreferences',
    reset: 'resetPreferencesList',
    retryPage: 'retryPreferencesPage',
  },
] as const;

const state = () => useUserMemoryStore.getState() as unknown as Record<string, any>;

beforeEach(() => {
  useUserMemoryStore.setState({ ...initialState }, false);
});

describe.each(lists)('$reset', ({ fields, key, loadMore, reset, retryPage }) => {
  const call = (params?: Record<string, unknown>, epoch?: number) => state()[reset](params, epoch);

  /** Put the store where a settled visit leaves it: rows on screen, page 2. */
  const seedLoadedList = (params: Record<string, unknown>) => {
    call(params);
    useUserMemoryStore.setState(
      {
        [key]: stubRows(),
        [`${key}HasMore`]: true,
        [`${key}Page`]: 2,
        [`${key}SearchLoading`]: false,
        [`${key}Settled`]: true,
        [`${key}Total`]: 50,
      } as never,
      false,
    );
  };

  it('is a no-op when the query already settled in the store', () => {
    seedLoadedList(fields);

    call({ ...fields });

    // The pages call this from a mount effect: re-running it on a revisit must
    // not wipe rows or flip the list back into its loading state.
    expect(state()[key]).toHaveLength(1);
    expect(state()[`${key}Page`]).toBe(2);
    expect(state()[`${key}SearchLoading`]).toBe(false);
    expect(state()[`${key}Settled`]).toBe(true);
  });

  it('keeps the loaded rows on screen while a changed query is in flight', () => {
    seedLoadedList(fields);

    call({ ...fields, q: 'research' });

    expect(state()[key]).toHaveLength(1);
    expect(state()[`${key}Page`]).toBe(1);
    expect(state()[`${key}SearchLoading`]).toBe(true);
    // Not settled: nothing may accumulate on top of the previous query's rows.
    expect(state()[`${key}Settled`]).toBe(false);
  });

  it('latches hasMore off across a reset so the virtualized list stops asking', () => {
    seedLoadedList(fields);

    call({ ...fields, q: 'research' });

    expect(state()[`${key}HasMore`]).toBe(false);
  });

  it('refuses to page while the reset is in flight', () => {
    seedLoadedList(fields);
    call({ ...fields, q: 'research' });

    state()[loadMore]();

    // Bumping the page here would fetch page 2 of the *new* query and append
    // it to the old query's rows — a permanently mixed list with the new
    // query's page 1 missing.
    expect(state()[`${key}Page`]).toBe(1);
  });

  it('pages normally once the query has settled', () => {
    seedLoadedList(fields);

    state()[loadMore]();

    expect(state()[`${key}Page`]).toBe(3);
    expect(state()[`${key}PendingPage`]).toBe(3);
  });

  it('refuses a second page request while one is still outstanding', () => {
    seedLoadedList(fields);

    state()[loadMore]();
    state()[loadMore]();

    // Remounting the virtualizer fires `endReached` again at the bottom of the
    // list. Skipping ahead loses the page that is still in flight: it is
    // rejected by the page guard when it lands, and nothing ever asks again.
    expect(state()[`${key}Page`]).toBe(3);
    expect(state()[`${key}PendingPage`]).toBe(3);
  });

  it('will not skip past a page that failed', () => {
    seedLoadedList(fields);
    useUserMemoryStore.setState({ [`${key}PageError`]: new Error('boom') } as never, false);

    state()[loadMore]();

    expect(state()[`${key}Page`]).toBe(2);
  });

  it('retries the page that failed rather than the one after it', () => {
    seedLoadedList(fields);
    useUserMemoryStore.setState({ [`${key}PageError`]: new Error('boom') } as never, false);

    state()[retryPage]();

    expect(state()[`${key}PageError`]).toBeUndefined();
    expect(state()[`${key}Page`]).toBe(2);
    expect(state()[`${key}PendingPage`]).toBe(2);
  });

  it('clears the pagination latches when the query changes', () => {
    seedLoadedList(fields);
    state()[loadMore]();
    useUserMemoryStore.setState({ [`${key}PageError`]: new Error('boom') } as never, false);

    call({ ...fields, q: 'research' });

    expect(state()[`${key}PendingPage`]).toBeUndefined();
    expect(state()[`${key}PageError`]).toBeUndefined();
  });

  it('never hands the same epoch back to a query that is returned to', () => {
    seedLoadedList(fields);
    const first = state()[`${key}Epoch`];

    call({ ...fields, q: 'research' });
    const second = state()[`${key}Epoch`];

    call({ ...fields });
    const third = state()[`${key}Epoch`];

    // Leave a query with a request in flight, go elsewhere, come back: a
    // counter that restarted per query would recreate the exact tuple that
    // request is stamped with, and its stale rows would settle the list.
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('only ever steps the generation forward', () => {
    seedLoadedList(fields);
    useUserMemoryStore.setState({ [`${key}Generation`]: 4 } as never, false);

    // A different query gets a new epoch, which is discrimination enough.
    call({ ...fields, q: 'research' });
    expect(state()[`${key}Generation`]).toBe(4);

    // A retry keeps the key and the epoch, so only the counter can invalidate
    // whatever the failed attempt left in flight.
    call({ ...fields, q: 'research' });
    expect(state()[`${key}Generation`]).toBe(5);
  });

  it('adopts a remount epoch without disturbing the rows it finds', () => {
    seedLoadedList(fields);

    // A remount of the same query: the reset is a no-op for the data, but the
    // revalidation it is about to run already carries the new epoch.
    call({ ...fields }, 9999);

    expect(state()[`${key}Epoch`]).toBe(9999);
    expect(state()[key]).toHaveLength(1);
    expect(state()[`${key}Settled`]).toBe(true);
    expect(state()[`${key}SearchLoading`]).toBe(false);
  });

  it('resets a cold list even when the query is the initial one', () => {
    call();

    expect(state()[`${key}SearchLoading`]).toBe(true);
    expect(state()[`${key}Page`]).toBe(1);
  });

  describe.each(Object.keys(fields))('query identity covers %s', (field) => {
    it('treats a change to it as a different query', () => {
      seedLoadedList(fields);

      const changed = Array.isArray((fields as Record<string, unknown>)[field])
        ? ['something-else']
        : 'something-else';

      call({ ...fields, [field]: changed });

      expect(state()[`${key}SearchLoading`]).toBe(true);
      expect(state()[`${key}Settled`]).toBe(false);
    });

    it('treats dropping it as a different query', () => {
      seedLoadedList(fields);

      call({ ...fields, [field]: undefined });

      expect(state()[`${key}SearchLoading`]).toBe(true);
      expect(state()[`${key}Settled`]).toBe(false);
    });
  });
});

describe('memoryListQueryKey', () => {
  it('collapses every spelling of "not filtered" to one key', () => {
    const empty = memoryListQueryKey();

    expect(memoryListQueryKey({ q: undefined, types: undefined })).toBe(empty);
    expect(memoryListQueryKey({ q: '', types: [] })).toBe(empty);
    expect(memoryListQueryKey({ q: null, types: null })).toBe(empty);
  });

  it('ignores key order and array order', () => {
    expect(memoryListQueryKey({ q: 'a', types: ['x', 'y'] })).toBe(
      memoryListQueryKey({ types: ['y', 'x'], q: 'a' }),
    );
  });

  it('separates queries that differ in any single field', () => {
    const base = { q: 'a', sort: 'startsAt', status: ['done'], types: ['task'] };

    expect(memoryListQueryKey({ ...base, q: 'b' })).not.toBe(memoryListQueryKey(base));
    expect(memoryListQueryKey({ ...base, sort: 'capturedAt' })).not.toBe(memoryListQueryKey(base));
    expect(memoryListQueryKey({ ...base, status: ['todo'] })).not.toBe(memoryListQueryKey(base));
    expect(memoryListQueryKey({ ...base, types: ['event'] })).not.toBe(memoryListQueryKey(base));
  });
});
