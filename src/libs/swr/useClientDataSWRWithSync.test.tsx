// Regression guard for the store-sync helper losing a KEY CHANGE.
//
// The admin provider detail route keeps the same hook instance alive while the
// `:id` segment changes. The helper used to track "already synced" as a plain
// boolean reset in an effect declared AFTER the sync effect: on a warm/deduped
// key change the sync effect saw the stale `true`, skipped `onData`, and the
// reset effect then cleared the flag without scheduling another render — so the
// store kept the PREVIOUS provider's data.
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { SWRConfig, unstable_serialize, useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useClientDataSWRWithSync } from './useClientDataSWRWithSync';

// `useClientDataSWR` scopes every key by the active workspace, so the sync identity has to be the
// AUGMENTED key. Mocking the module makes both sides (the subscription and the identity) move
// together, which is exactly what the workspace-switch regression needs.
const workspace = vi.hoisted(() => ({ id: null as string | null }));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: () => workspace.id,
  useActiveWorkspaceId: () => workspace.id,
}));

/** A request that never settles: what a deduped / cache-served mount looks like. */
const neverSettles = () => new Promise<string>(() => {});

const providerKey = (id: string) => ['provider-item', id];

const renderWithCache = (
  cache: Map<unknown, unknown>,
  useHook: (props: { id: string | null }) => unknown,
  initialProps: { id: string | null },
) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache as never }}>{children}</SWRConfig>
  );

  return renderHook(useHook, { initialProps, wrapper });
};

beforeEach(() => {
  workspace.id = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useClientDataSWRWithSync', () => {
  it('syncs the new key data when the key changes on a warm cache', async () => {
    // Only `b` is warm. `a` is fetched normally, so it is synced from `onSuccess`
    // and leaves the helper in the "already synced" state — exactly the state the
    // key change has to invalidate. The switch to `b` then produces no further
    // render (cached data, deduped request), so a late reset can never rescue it.
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('b')), { data: 'detail-b' }],
    ]);
    const onData = vi.fn();

    const { rerender } = renderWithCache(
      cache,
      // A STABLE `onData`: the sync effect then only re-runs when the data or the
      // key actually changes, so nothing but the key handling can rescue a miss.
      ({ id }) =>
        useClientDataSWRWithSync<string>(
          providerKey(id as string),
          id === 'a' ? async () => 'detail-a' : neverSettles,
          { onData },
        ),
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledWith('detail-a'));

    rerender({ id: 'b' });

    await waitFor(() => expect(onData).toHaveBeenCalledWith('detail-b'));
    expect(onData).toHaveBeenCalledTimes(2);
  });

  it('syncs again when the key switches back to a previously synced one', async () => {
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
      [unstable_serialize(providerKey('b')), { data: 'detail-b' }],
    ]);
    const onData = vi.fn();

    const { rerender } = renderWithCache(
      cache,
      ({ id }) =>
        useClientDataSWRWithSync<string>(providerKey(id as string), neverSettles, {
          onData: (data) => onData(data),
        }),
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledTimes(1));
    rerender({ id: 'b' });
    await waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    rerender({ id: 'a' });
    await waitFor(() => expect(onData).toHaveBeenCalledTimes(3));

    expect(onData.mock.calls.map(([data]) => data)).toEqual(['detail-a', 'detail-b', 'detail-a']);
  });

  it('does not re-sync when the same key re-renders', async () => {
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
    ]);
    const onData = vi.fn();

    const { rerender } = renderWithCache(
      cache,
      ({ id }) =>
        useClientDataSWRWithSync<string>(providerKey(id as string), neverSettles, {
          onData: (data) => onData(data),
        }),
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledTimes(1));

    rerender({ id: 'a' });
    rerender({ id: 'a' });
    await Promise.resolve();

    expect(onData).toHaveBeenCalledTimes(1);
  });

  it('skips syncing while the key is null', async () => {
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
    ]);
    const onData = vi.fn();

    const { rerender } = renderWithCache(
      cache,
      ({ id }) =>
        useClientDataSWRWithSync<string>(id === null ? null : providerKey(id), neverSettles, {
          onData: (data) => onData(data),
        }),
      { id: null },
    );

    await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();

    rerender({ id: 'a' });
    await waitFor(() => expect(onData).toHaveBeenCalledWith('detail-a'));
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it('forwards onSuccess and syncs fresh data exactly once', async () => {
    const cache = new Map<unknown, unknown>();
    const onData = vi.fn();
    const onSuccess = vi.fn();

    renderWithCache(
      cache,
      () =>
        useClientDataSWRWithSync<string>(providerKey('fresh'), async () => 'detail-fresh', {
          onData: (data) => onData(data),
          onSuccess,
        }),
      { id: 'fresh' },
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0][0]).toBe('detail-fresh');

    await waitFor(() => expect(onData).toHaveBeenCalledWith('detail-fresh'));
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it('never syncs while skipSync is set', async () => {
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
    ]);
    const onData = vi.fn();

    renderWithCache(
      cache,
      () =>
        useClientDataSWRWithSync<string>(providerKey('a'), neverSettles, {
          onData: (data) => onData(data),
          skipSync: true,
        }),
      { id: 'a' },
    );

    await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();
  });

  it('syncs the new workspace data when the workspace switches on a warm cache', async () => {
    // Same logical key, two workspaces: `useClientDataSWR` subscribes to `[...key, workspaceId]`,
    // so the sync identity has to be that AUGMENTED key. Both entries are warm, so the switch
    // produces no request and no `onSuccess` — only the identity change can carry the new data.
    //
    // `ws-3` holds the very same payload REFERENCE as `ws-2`: two workspaces may legitimately
    // hold an equal value (both empty, both defaults), and then the key is the only thing that
    // distinguishes them. Consumers store the scope alongside the data (see `useFetchRecents`),
    // so they must still be told the value now belongs to another workspace.
    const shared = ['detail-shared'];
    const cache = new Map<unknown, unknown>([
      [unstable_serialize([...providerKey('a'), 'ws-1']), { data: ['detail-ws-1'] }],
      [unstable_serialize([...providerKey('a'), 'ws-2']), { data: shared }],
      [unstable_serialize([...providerKey('a'), 'ws-3']), { data: shared }],
    ]);
    const onData = vi.fn();
    workspace.id = 'ws-1';

    const { rerender } = renderWithCache(
      cache,
      () =>
        useClientDataSWRWithSync<string[]>(providerKey('a'), neverSettles as never, {
          onData: (data) => onData(data),
        }),
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledWith(['detail-ws-1']));

    workspace.id = 'ws-2';
    rerender({ id: 'a' });
    await waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    expect(onData).toHaveBeenLastCalledWith(shared);

    workspace.id = 'ws-3';
    rerender({ id: 'a' });
    await waitFor(() => expect(onData).toHaveBeenCalledTimes(3));
    expect(onData).toHaveBeenLastCalledWith(shared);
  });

  it('syncs a same-key cache replacement written by mutate', async () => {
    // A warm mount syncs `detail-a`; an external `mutate(key, next, { revalidate: false })` — a
    // write-through from some other action — must still reach the store, exactly once.
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
    ]);
    const onData = vi.fn();

    const { result } = renderWithCache(
      cache,
      () => {
        const { mutate } = useSWRConfig();
        useClientDataSWRWithSync<string>(providerKey('a'), neverSettles, {
          onData: (data) => onData(data),
        });
        return mutate;
      },
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledTimes(1));

    await act(async () => {
      await (result.current as ReturnType<typeof useSWRConfig>['mutate'])(
        providerKey('a'),
        'detail-a-next',
        { revalidate: false },
      );
    });

    await waitFor(() => expect(onData).toHaveBeenLastCalledWith('detail-a-next'));
    expect(onData).toHaveBeenCalledTimes(2);
  });

  it('re-syncs the same key after it was disabled and re-enabled', async () => {
    // `A -> null -> A`: the null phase must clear the sync record, otherwise the warm `A` value is
    // mistaken for "already applied" and the store keeps whatever the null phase left behind.
    const cache = new Map<unknown, unknown>([
      [unstable_serialize(providerKey('a')), { data: 'detail-a' }],
    ]);
    const onData = vi.fn();

    const { rerender } = renderWithCache(
      cache,
      ({ id }) =>
        useClientDataSWRWithSync<string>(id === null ? null : providerKey(id), neverSettles, {
          onData: (data) => onData(data),
        }),
      { id: 'a' },
    );

    await waitFor(() => expect(onData).toHaveBeenCalledTimes(1));

    rerender({ id: null });
    await Promise.resolve();
    // Nothing is synced while the key is disabled.
    expect(onData).toHaveBeenCalledTimes(1);

    rerender({ id: 'a' });
    await waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    expect(onData.mock.calls.map(([data]) => data)).toEqual(['detail-a', 'detail-a']);
  });
});
