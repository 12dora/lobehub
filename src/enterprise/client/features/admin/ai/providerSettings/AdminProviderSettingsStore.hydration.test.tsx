// Regression guard for the admin "Providers" tab hanging on the loading skeleton.
//
// The admin surface builds a FRESH scoped aiInfra store on every route mount
// (list and detail are two separate route elements), while SWR keeps
// `admin:FETCH_AI_PROVIDER` in its in-memory cache. Before the fix,
// `initAiProviderList` was only written from SWR `onSuccess`, so a remount served
// from cache — no new request, no `onSuccess` — left the flag `false` forever and
// `ProviderMenu` / `ProviderGrid` kept rendering skeletons.
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig, unstable_serialize } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiInfraStoreApi, useScopedAiInfraStore } from '@/store/aiInfra';
import type { AiProviderDetailItem, AiProviderListItem } from '@/types/aiProvider';

import { AdminProviderSettingsStoreProvider } from './AdminProviderSettingsStore';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviders: {
        applyImmediate: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        get: { query: mocks.get },
        getBatch: { query: vi.fn() },
        list: { query: mocks.list },
      },
    },
  },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  AdminReauthBlockedError: class extends Error {},
  AdminReauthCancelledError: class extends Error {},
  withAdminReauthRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The admin adapter scopes its SWR keys with `swrScope: 'admin'`.
const LIST_CACHE_KEY = unstable_serialize('admin:FETCH_AI_PROVIDER');
const detailCacheKey = (id: string) => unstable_serialize(['admin', 'FETCH_AI_PROVIDER_ITEM', id]);

const cachedProviders = [
  { enabled: true, id: 'openai', name: 'OpenAI', source: 'builtin' },
] as unknown as AiProviderListItem[];

let renderedInit: boolean[] = [];

const Probe = () => {
  const [initAiProviderList, useFetchAiProviderList] = useScopedAiInfraStore((s) => [
    s.initAiProviderList,
    s.useFetchAiProviderList,
  ]);
  const storeApi = useAiInfraStoreApi();

  useFetchAiProviderList();
  renderedInit.push(initAiProviderList);

  return (
    <div>
      <span data-testid={'init'}>{String(initAiProviderList)}</span>
      <span data-testid={'count'}>{storeApi.getState().aiProviderList.length}</span>
    </div>
  );
};

const renderWithWarmCache = (cache: Map<unknown, unknown>) =>
  render(
    <SWRConfig value={{ provider: () => cache as never }}>
      <AdminProviderSettingsStoreProvider>
        <Probe />
      </AdminProviderSettingsStoreProvider>
    </SWRConfig>,
  );

describe('AdminProviderSettingsStoreProvider — provider list hydration', () => {
  beforeEach(() => {
    renderedInit = [];
    // A request that never settles: exactly what a deduped / cache-served mount
    // looks like from the store's point of view — `onSuccess` never runs.
    mocks.list.mockImplementation(() => new Promise(() => {}));
    mocks.get.mockImplementation(() => new Promise(() => {}));
  });

  it('hydrates initAiProviderList from a warm SWR cache when onSuccess never fires', async () => {
    const cache = new Map<unknown, unknown>([[LIST_CACHE_KEY, { data: cachedProviders }]]);

    renderWithWarmCache(cache);

    await waitFor(() => {
      expect(screen.getByTestId('init').textContent).toBe('true');
    });
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('stays hydrated when the scoped store is recreated on a route remount', async () => {
    const cache = new Map<unknown, unknown>([[LIST_CACHE_KEY, { data: cachedProviders }]]);

    const first = renderWithWarmCache(cache);
    await waitFor(() => expect(screen.getByTestId('init').textContent).toBe('true'));
    first.unmount();

    // Second mount = brand-new zustand store (list -> detail navigation), same
    // warm SWR cache. This is the mount that used to be stuck on skeletons.
    renderedInit = [];
    renderWithWarmCache(cache);

    await waitFor(() => expect(screen.getByTestId('init').textContent).toBe('true'));
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('follows the provider id when the detail route switches without a remount', async () => {
    // Navigating `/admin/ai/providers/:id` keeps the same store and the same hook
    // instance alive — only the SWR key changes. Both details are cached, so the
    // switch produces no new request and no `onSuccess`.
    const openai = { enabled: true, id: 'openai', name: 'OpenAI' } as AiProviderDetailItem;
    const anthropic = { enabled: true, id: 'anthropic', name: 'Anthropic' } as AiProviderDetailItem;
    const cache = new Map<unknown, unknown>([
      [detailCacheKey('openai'), { data: openai }],
      [detailCacheKey('anthropic'), { data: anthropic }],
    ]);

    const DetailProbe = ({ id }: { id: string }) => {
      const useFetchAiProviderItem = useScopedAiInfraStore((s) => s.useFetchAiProviderItem);
      const activeAiProvider = useScopedAiInfraStore((s) => s.activeAiProvider);
      const detailName = useScopedAiInfraStore((s) => s.aiProviderDetailMap[id]?.name ?? '');

      useFetchAiProviderItem(id);

      return (
        <div>
          <span data-testid={'active'}>{String(activeAiProvider)}</span>
          <span data-testid={'detail'}>{detailName}</span>
        </div>
      );
    };

    const Tree = ({ id }: { id: string }) => (
      <SWRConfig value={{ provider: () => cache as never }}>
        <AdminProviderSettingsStoreProvider>
          <DetailProbe id={id} />
        </AdminProviderSettingsStoreProvider>
      </SWRConfig>
    );

    const { rerender } = render(<Tree id={'openai'} />);
    await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('OpenAI'));

    rerender(<Tree id={'anthropic'} />);

    await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('Anthropic'));
    expect(screen.getByTestId('active').textContent).toBe('anthropic');
  });

  it('does not hydrate anything when the SWR cache is cold', async () => {
    const cache = new Map<unknown, unknown>();

    renderWithWarmCache(cache);

    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(screen.getByTestId('init').textContent).toBe('false');
    // No spurious `initAiProviderList: true` before data actually arrives.
    expect(renderedInit.every((value) => value === false)).toBe(true);
  });
});
