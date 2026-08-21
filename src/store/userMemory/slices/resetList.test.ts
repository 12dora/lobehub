import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SwrLib from '@/libs/swr';
import { mutate } from '@/libs/swr';
import { memoryCRUDService } from '@/services/userMemory';
import { useUserMemoryStore } from '@/store/userMemory';
import { initialState } from '@/store/userMemory/initialState';

vi.mock('@/libs/swr', async (importOriginal) => {
  const actual = await importOriginal<typeof SwrLib>();

  return { ...actual, mutate: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@/services/userMemory', () => ({
  memoryCRUDService: {
    deleteActivity: vi.fn().mockResolvedValue(undefined),
    deleteContext: vi.fn().mockResolvedValue(undefined),
    deleteExperience: vi.fn().mockResolvedValue(undefined),
    deleteIdentity: vi.fn().mockResolvedValue(undefined),
    deletePreference: vi.fn().mockResolvedValue(undefined),
  },
  userMemoryService: {},
}));

/** The reset guard only cares about row *count*, never row shape. */
const stubRows = () => [{ id: 'row-1' }] as unknown as never[];

/**
 * The five memory list slices are the same slice five times over. Table-drive
 * the shared contract so a new one can't quietly ship without the guard.
 */
const lists = [
  { key: 'activities', reset: 'resetActivitiesList' },
  { key: 'contexts', reset: 'resetContextsList' },
  { key: 'experiences', reset: 'resetExperiencesList' },
  { key: 'identities', reset: 'resetIdentitiesList' },
  { key: 'preferences', reset: 'resetPreferencesList' },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  useUserMemoryStore.setState({ ...initialState }, false);
});

describe.each(lists)('$reset', ({ key, reset }) => {
  const state = () => useUserMemoryStore.getState() as unknown as Record<string, any>;
  const call = (params?: Record<string, unknown>) => state()[reset](params);

  const seedLoadedList = () =>
    useUserMemoryStore.setState(
      {
        [key]: stubRows(),
        [`${key}Init`]: true,
        [`${key}Page`]: 2,
        [`${key}Query`]: 'design',
        [`${key}SearchLoading`]: false,
      } as never,
      false,
    );

  it('is a no-op when the query already matches what the store fetched', () => {
    seedLoadedList();

    call({ q: 'design' });

    // The pages call this from a mount effect: re-running it on a revisit must
    // not wipe rows or flip the list back into its loading state.
    expect(state()[key]).toHaveLength(1);
    expect(state()[`${key}Page`]).toBe(2);
    expect(state()[`${key}SearchLoading`]).toBe(false);
  });

  it('keeps the loaded rows on screen while a changed query is in flight', () => {
    seedLoadedList();

    call({ q: 'research' });

    expect(state()[key]).toHaveLength(1);
    expect(state()[`${key}Query`]).toBe('research');
    expect(state()[`${key}Page`]).toBe(1);
    expect(state()[`${key}SearchLoading`]).toBe(true);
  });

  it('resets a cold list even when the query is the initial one', () => {
    call();

    expect(state()[`${key}SearchLoading`]).toBe(true);
    expect(state()[`${key}Page`]).toBe(1);
  });
});

describe('list refresh after a write', () => {
  it('rewinds to page 1 and revalidates every cached page of the list', async () => {
    useUserMemoryStore.setState(
      {
        identities: stubRows(),
        identitiesInit: true,
        identitiesPage: 3,
        identitiesQuery: 'design',
        identitiesSearchLoading: false,
      } as never,
      false,
    );

    await useUserMemoryStore.getState().deleteIdentity('row-1');

    expect(memoryCRUDService.deleteIdentity).toHaveBeenCalledWith('row-1');
    expect(useUserMemoryStore.getState().identitiesPage).toBe(1);
    expect(useUserMemoryStore.getState().identitiesSearchLoading).toBe(true);

    // The query is unchanged, so the SWR key can't do the invalidating for us.
    const matcher = vi.mocked(mutate).mock.calls[0][0] as (key: unknown) => boolean;
    expect(matcher(['userMemory:identityList', { page: 1 }])).toBe(true);
    expect(matcher(['userMemory:contexts', { page: 1 }])).toBe(false);
  });
});
