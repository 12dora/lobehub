// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_AGENT_TEMPLATES_KEY } from '@/enterprise/client/hooks/usePlatformAgentTemplates';

import { ADMIN_AGENT_TEMPLATE_LIST_KEY, buildAdminAgentTemplateListKey } from './swrKeys';

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@/libs/swr', () => ({
  mutate: (...args: unknown[]) => mocks.mutate(...args),
  useClientDataSWR: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminAgentTemplates', () => ({
  adminAgentTemplatesService: { list: vi.fn() },
}));

type Predicate = (key: unknown) => boolean;

/** One cached admin page, shaped the way the list procedure answers. */
const page = {
  items: [{ id: 'tpl-1', revision: 3 }],
  totalAll: 1,
  totalFiltered: 1,
};

const adminKey = [...buildAdminAgentTemplateListKey({ limit: 20, locale: 'en-US', offset: 0 })];
const platformKey = [PLATFORM_AGENT_TEMPLATES_KEY];

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

describe('refreshAdminAgentTemplateLists', () => {
  it('invalidates every cached admin page', async () => {
    const { refreshAdminAgentTemplateLists } = await import('./useAdminAgentTemplates');

    await refreshAdminAgentTemplateLists();

    const [matchesAdmin] = predicates();
    expect(matchesAdmin!(adminKey)).toBe(true);
    expect(matchesAdmin!(workspaceScoped(adminKey))).toBe(true);
  });

  it('clears the matched entries instead of only revalidating mounted subscribers', async () => {
    const { refreshAdminAgentTemplateLists } = await import('./useAdminAgentTemplates');

    await refreshAdminAgentTemplateLists();

    // `mutate(predicate)` alone never reaches an unmounted reader's cache entry.
    expect(evictionArgs()).toEqual([
      [undefined, { revalidate: true }],
      [undefined, { revalidate: true }],
    ]);
  });

  it('returns nothing, so no caller can mistake a cache round trip for an authoritative read', async () => {
    const { refreshAdminAgentTemplateLists } = await import('./useAdminAgentTemplates');

    await expect(refreshAdminAgentTemplateLists()).resolves.toBeUndefined();
  });

  it('also drops the user-facing example cache the operator sees in the same session', async () => {
    // Without this the operator's own create-agent modal keeps serving the pre-edit templates
    // until a reload: the admin table and the modal read two different SWR keys.
    const { refreshAdminAgentTemplateLists } = await import('./useAdminAgentTemplates');

    await refreshAdminAgentTemplateLists();

    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    const matchesPlatform = predicates().find((predicate) => predicate(platformKey));
    expect(matchesPlatform).toBeDefined();
    expect(matchesPlatform!(workspaceScoped(platformKey))).toBe(true);
  });

  it('keeps the two invalidations disjoint so neither key steals the other rows', async () => {
    const { refreshAdminAgentTemplateLists } = await import('./useAdminAgentTemplates');

    await refreshAdminAgentTemplateLists();

    const [matchesAdmin, matchesPlatform] = predicates();
    expect(matchesAdmin!(platformKey)).toBe(false);
    expect(matchesPlatform!(adminKey)).toBe(false);
    // A non-array key (SWR allows plain strings) must not blow up either predicate.
    expect(matchesAdmin!(ADMIN_AGENT_TEMPLATE_LIST_KEY)).toBe(false);
    expect(matchesPlatform!(PLATFORM_AGENT_TEMPLATES_KEY)).toBe(false);
  });
});

describe('buildAdminAgentTemplateListKey', () => {
  it('separates two console languages: each renders its own library preview', () => {
    expect(buildAdminAgentTemplateListKey({ limit: 20, locale: 'zh-CN', offset: 0 })).not.toEqual(
      buildAdminAgentTemplateListKey({ limit: 20, locale: 'en-US', offset: 0 }),
    );
  });

  it('still keys on the filters, so one page never serves the rows of another', () => {
    const base = { limit: 20, locale: 'en-US', offset: 0 };

    expect(buildAdminAgentTemplateListKey({ ...base, offset: 20 })).not.toEqual(
      buildAdminAgentTemplateListKey(base),
    );
    expect(buildAdminAgentTemplateListKey({ ...base, enabled: false })).not.toEqual(
      buildAdminAgentTemplateListKey(base),
    );
    expect(buildAdminAgentTemplateListKey({ ...base, query: 'digest' })).not.toEqual(
      buildAdminAgentTemplateListKey(base),
    );
  });

  it('is stable for the same query, so SWR reuses the cached page', () => {
    expect(
      buildAdminAgentTemplateListKey({ limit: 20, locale: 'en-US', offset: 0, query: 'digest' }),
    ).toEqual(
      buildAdminAgentTemplateListKey({ limit: 20, locale: 'en-US', offset: 0, query: 'digest' }),
    );
  });
});
