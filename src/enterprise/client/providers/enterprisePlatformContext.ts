'use client';

import { createContext, use } from 'react';

import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

/**
 * The platform context, split out from the provider component on purpose.
 *
 * `EnterprisePlatformProvider` pulls in the skill catalog, the tool store and the branding
 * provider. Consumers that only need to *read* a capability (module gates, badges) must not drag
 * that graph into their chunk — or into their unit tests, which then have to mock half the
 * design system. Import the provider to mount it; import this to read it.
 */
export interface EnterprisePlatformContextValue {
  capabilities: PlatformCapabilities;
  error: Error | null;
  loading: boolean;
  publicSnapshot: PlatformPublicSnapshot;
  refresh: () => Promise<void>;
}

export const EnterprisePlatformContext = createContext<EnterprisePlatformContextValue | null>(null);

export const useEnterprisePlatform = (): EnterprisePlatformContextValue => {
  const ctx = use(EnterprisePlatformContext);
  if (!ctx) {
    // Safe fallback for tests or partial trees — never throw when flags are off.
    return {
      capabilities: DISABLED_PLATFORM_CAPABILITIES,
      error: null,
      loading: false,
      publicSnapshot: DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      refresh: async () => {},
    };
  }
  return ctx;
};
