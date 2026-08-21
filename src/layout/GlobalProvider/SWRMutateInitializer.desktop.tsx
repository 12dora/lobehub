'use client';

import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { type PropsWithChildren, useEffect } from 'react';
import { useSWRConfig } from 'swr';

import { setScopedCache, setScopedMutate } from '@/libs/swr';

/**
 * Initialize the scoped mutate and cache for use outside React components (e.g.
 * Zustand stores). Desktop variant: also listens to Electron IPC for remote
 * server config updates.
 *
 * Keep this in step with the base `SWRMutateInitializer`. Publishing only
 * `mutate` here left `getScopedCache()` null on desktop, so every cache
 * eviction silently degraded to blanking entries that were never removed.
 */
const SWRMutateInitializer = ({ children }: PropsWithChildren) => {
  const { cache, mutate } = useSWRConfig();

  useEffect(() => {
    setScopedMutate(mutate);
  }, [mutate]);

  useEffect(() => {
    setScopedCache(cache);
  }, [cache]);

  useWatchBroadcast('remoteServerConfigUpdated', () => {
    try {
      const result = mutate(() => true, undefined, { revalidate: true });
      void result?.catch?.(() => {});
    } catch {
      // Ignore: SWR cache may not be ready yet in early boot.
    }
  });

  return <>{children}</>;
};

export default SWRMutateInitializer;
