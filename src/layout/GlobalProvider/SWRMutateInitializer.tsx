'use client';

import { type PropsWithChildren, useEffect } from 'react';
import { useSWRConfig } from 'swr';

import { setScopedCache, setScopedMutate } from '@/libs/swr';

/**
 * Initialize the scoped mutate and cache for use outside React components (e.g.
 * Zustand stores). This component must be rendered inside SWRConfig to reach either.
 */
const SWRMutateInitializer = ({ children }: PropsWithChildren) => {
  const { cache, mutate } = useSWRConfig();

  useEffect(() => {
    setScopedMutate(mutate);
  }, [mutate]);

  useEffect(() => {
    setScopedCache(cache);
  }, [cache]);

  return <>{children}</>;
};

export default SWRMutateInitializer;
