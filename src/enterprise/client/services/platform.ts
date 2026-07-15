import { lambdaClient } from '@/libs/trpc/client';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

/**
 * Client adapters for platform.* procedures.
 * Fail soft to disabled snapshots so closed flags never break the SPA shell.
 */
export const fetchPlatformCapabilities = async (): Promise<PlatformCapabilities> => {
  try {
    // Optional chaining: platform router may be absent on older servers during upgrade.
    const result = await (lambdaClient as any).platform?.getCapabilities?.query?.();
    if (!result) return { ...DISABLED_PLATFORM_CAPABILITIES };
    return result as PlatformCapabilities;
  } catch {
    return { ...DISABLED_PLATFORM_CAPABILITIES };
  }
};

export const fetchPlatformPublicSnapshot = async (): Promise<PlatformPublicSnapshot> => {
  try {
    const result = await (lambdaClient as any).platform?.getPublicSnapshot?.query?.();
    if (!result) return { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT };
    return result as PlatformPublicSnapshot;
  } catch {
    return { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT };
  }
};
