/**
 * useClientDataSWR with automatic Zustand store sync
 *
 * Solves the problem of SWR cached data not being immediately synced to Zustand store.
 * When SWR returns data from the persisted cache, it will automatically sync to store via onData callback.
 *
 * Persistence (localStorage vs IndexedDB) is handled transparently by the
 * tier-aware SWR cache provider (see `localStorageProvider.ts`) based on the
 * SWR key — consumers never need to opt in per call.
 */

import { useEffect, useRef } from 'react';
import { type Arguments, type SWRConfiguration, type SWRResponse, unstable_serialize } from 'swr';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';

import { augmentKey } from './augmentKey';
import { useClientDataSWR } from './index';

type Key = string | readonly unknown[] | null | undefined;

interface UseClientDataSWRWithSyncOptions<T> extends SWRConfiguration<T> {
  /**
   * Data sync callback, called when data is available (both cached and fresh data)
   * Used to sync data to Zustand store
   */
  onData?: (data: T) => void;
  /**
   * Whether to skip sync (optional, for conditional skipping)
   */
  skipSync?: boolean;
}

/** What was last handed to `onData`, and under which cache identity. */
interface SyncRecord {
  data: unknown;
  key: string;
}

/**
 * Hand `data` to `onData` at most once per `(key, data)` pair.
 *
 * Module scope on purpose: both call sites (SWR's `onSuccess` and the cache-hydration effect)
 * share one record, and the effect keeps honest dependencies.
 */
const syncOnce = <T>(
  record: { current: SyncRecord | null },
  key: string | null,
  data: T,
  onData?: (data: T) => void,
  skipSync?: boolean,
): void => {
  if (!onData || skipSync || key === null) return;

  const synced = record.current;
  // Same key AND same data reference: already applied, writing it again only churns subscribers.
  if (synced && synced.key === key && synced.data === data) return;

  onData(data);
  record.current = { data, key };
};

/**
 * Serialized identity of the cache entry `useClientDataSWR` actually subscribes to.
 *
 * It is NOT the caller's key: `useClientDataSWR` scopes every key by the active workspace
 * (`augmentKey`), so two workspaces share one logical key but live in two cache entries.
 * Tracking the caller key here would make a workspace switch look like "same key" and, on a warm
 * cache, skip the sync — leaving the store on the previous workspace's data.
 *
 * Returns `null` for SWR's "skip" keys (`null` / `undefined` / `false`).
 */
export const useAugmentedClientDataKey = (key: Key): string | null => {
  const workspaceId = useActiveWorkspaceId();
  const augmented = augmentKey(key, workspaceId);

  if (augmented === null || augmented === undefined || augmented === false) return null;

  return unstable_serialize(augmented as Arguments);
};

/**
 * Enhanced version of useClientDataSWR with automatic cache data sync to Zustand store
 *
 * @example
 * ```ts
 * useClientDataSWRWithSync(
 *   isLogin ? ['fetchAgentList', isLogin] : null,
 *   () => homeService.getSidebarAgentList(),
 *   {
 *     onData: (data) => {
 *       // Auto sync to store, whether cached or fresh data
 *       set({ ...mapResponseToState(data), isInit: true });
 *     },
 *     skipSync: state.isInit, // Optional: skip after initialized
 *   }
 * );
 * ```
 */
export function useClientDataSWRWithSync<T>(
  key: Key,
  fetcher: (() => Promise<T>) | null,
  options?: UseClientDataSWRWithSyncOptions<T>,
): SWRResponse<T> {
  const { onData, skipSync, onSuccess, ...swrOptions } = options || {};

  // What the store was last synced with — the (key, data) PAIR, not a plain boolean and not the
  // key alone. The same hook instance can outlive a key change (e.g. navigating between
  // `/admin/ai/providers/:id`) and can also receive a new value under an unchanged key (any
  // `mutate(key, next, { revalidate: false })` from elsewhere). Deduping on the pair syncs each
  // (key, data) exactly once while letting both of those through.
  const syncedRef = useRef<SyncRecord | null>(null);
  const serializedKey = useAugmentedClientDataKey(key);

  const response = useClientDataSWR<T>(key, fetcher, {
    ...swrOptions,
    onSuccess: (data, key, config) => {
      // Call original onSuccess
      onSuccess?.(data, key, config);
      // Also sync via onData. This path — unlike the effect below — also carries `undefined` /
      // `null` responses, which some callers use to clear derived state (e.g. an unlinked PR).
      // SWR only fires `onSuccess` while the key is still the current one, so `serializedKey`
      // from this render is the key the data belongs to.
      syncOnce(syncedRef, serializedKey, data, onData, skipSync);
    },
  });

  const { data } = response;

  // When cached data is available, sync to store immediately. The key comparison lives INSIDE this
  // effect on purpose: a separate "reset on key change" effect would run after this one and leave
  // the very first render of a new key unsynced.
  useEffect(() => {
    // Disabled key: never sync (any `data` still hanging around belongs to the previous key, or is
    // fallback/retained data), and drop the record so re-enabling the SAME key later re-syncs its
    // warm value instead of mistaking it for "already applied".
    if (serializedKey === null) {
      syncedRef.current = null;
      return;
    }

    if (!data) return;

    syncOnce(syncedRef, serializedKey, data, onData, skipSync);
  }, [data, onData, skipSync, serializedKey]);

  return response;
}
