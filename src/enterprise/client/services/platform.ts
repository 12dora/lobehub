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
 * Callers must gate on `serverConfig.enterprise.enabled` (see EnterprisePlatformProvider).
 */
export const fetchPlatformCapabilities = async (): Promise<PlatformCapabilities> => {
  try {
    return await lambdaClient.platform.getCapabilities.query();
  } catch {
    return { ...DISABLED_PLATFORM_CAPABILITIES };
  }
};

export const fetchPlatformPublicSnapshot = async (): Promise<PlatformPublicSnapshot> => {
  try {
    return await lambdaClient.platform.getPublicSnapshot.query();
  } catch {
    return { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT };
  }
};
