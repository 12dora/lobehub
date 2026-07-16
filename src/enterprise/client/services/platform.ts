import { lambdaClient } from '@/libs/trpc/client';
import { type PlatformCapabilities } from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

/**
 * Client adapters for platform.* procedures.
 * Callers must gate on `serverConfig.enterprise.enabled` (see EnterprisePlatformProvider).
 * Capability errors intentionally propagate: enabled enterprise policy must not fail open.
 */
export const fetchPlatformCapabilities = async (
  query: () => Promise<PlatformCapabilities> = () => lambdaClient.platform.getCapabilities.query(),
): Promise<PlatformCapabilities> => query();

export const fetchPlatformPublicSnapshot = async (
  query: () => Promise<PlatformPublicSnapshot> = () =>
    lambdaClient.platform.getPublicSnapshot.query(),
): Promise<PlatformPublicSnapshot> => {
  try {
    return await query();
  } catch {
    return { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT };
  }
};
