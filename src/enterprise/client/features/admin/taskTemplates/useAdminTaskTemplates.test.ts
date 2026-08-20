// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_TASK_TEMPLATES_KEY } from '@/enterprise/client/hooks/usePlatformTaskTemplates';

import { ADMIN_TASK_TEMPLATE_LIST_KEY } from './swrKeys';

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@/libs/swr', () => ({
  mutate: (...args: unknown[]) => mocks.mutate(...args),
  useClientDataSWR: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminTaskTemplates', () => ({
  adminTaskTemplatesService: { list: vi.fn() },
}));

type Predicate = (key: unknown) => boolean;

/** One cached admin page, shaped the way the list procedure answers. */
const page = {
  items: [{ id: 'tpl-1', revision: 3 }],
  totalAll: 1,
  totalFiltered: 1,
};

const adminKey = [ADMIN_TASK_TEMPLATE_LIST_KEY, '', 20, 0, ''];
const platformKey = [PLATFORM_TASK_TEMPLATES_KEY];

/** `augmentKey` appends the active workspace id to array keys, so both shapes must match. */
const workspaceScoped = (key: unknown[]) => [...key, 'ws-1'];

const predicates = (): Predicate[] => mocks.mutate.mock.calls.map((call) => call[0] as Predicate);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutate.mockImplementation((predicate: Predicate) =>
    Promise.resolve(predicate(adminKey) ? [page] : []),
  );
});

/** Both invalidations must *evict*, not merely revalidate — see the integration suite. */
const evictionArgs = () => mocks.mutate.mock.calls.map((call) => [call[1], call[2]]);

describe('refreshAdminTaskTemplateLists', () => {
  it('invalidates every cached admin page', async () => {
    const { refreshAdminTaskTemplateLists } = await import('./useAdminTaskTemplates');

    await refreshAdminTaskTemplateLists();

    const [matchesAdmin] = predicates();
    expect(matchesAdmin!(adminKey)).toBe(true);
    expect(matchesAdmin!(workspaceScoped(adminKey))).toBe(true);
  });

  it('clears the matched entries instead of only revalidating mounted subscribers', async () => {
    const { refreshAdminTaskTemplateLists } = await import('./useAdminTaskTemplates');

    await refreshAdminTaskTemplateLists();

    // `mutate(predicate)` alone never reaches an unmounted reader's cache entry.
    expect(evictionArgs()).toEqual([
      [undefined, { revalidate: true }],
      [undefined, { revalidate: true }],
    ]);
  });

  it('returns nothing, so no caller can mistake a cache round trip for an authoritative read', async () => {
    const { refreshAdminTaskTemplateLists } = await import('./useAdminTaskTemplates');

    await expect(refreshAdminTaskTemplateLists()).resolves.toBeUndefined();
  });

  it('also drops the user-facing example cache the operator sees in the same session', async () => {
    // Without this the operator's own create-agent modal keeps serving the pre-edit templates
    // until a reload: the admin table and the modal read two different SWR keys.
    const { refreshAdminTaskTemplateLists } = await import('./useAdminTaskTemplates');

    await refreshAdminTaskTemplateLists();

    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    const matchesPlatform = predicates().find((predicate) => predicate(platformKey));
    expect(matchesPlatform).toBeDefined();
    expect(matchesPlatform!(workspaceScoped(platformKey))).toBe(true);
  });

  it('keeps the two invalidations disjoint so neither key steals the other rows', async () => {
    const { refreshAdminTaskTemplateLists } = await import('./useAdminTaskTemplates');

    await refreshAdminTaskTemplateLists();

    const [matchesAdmin, matchesPlatform] = predicates();
    expect(matchesAdmin!(platformKey)).toBe(false);
    expect(matchesPlatform!(adminKey)).toBe(false);
    // A non-array key (SWR allows plain strings) must not blow up either predicate.
    expect(matchesAdmin!(ADMIN_TASK_TEMPLATE_LIST_KEY)).toBe(false);
    expect(matchesPlatform!(PLATFORM_TASK_TEMPLATES_KEY)).toBe(false);
  });
});
