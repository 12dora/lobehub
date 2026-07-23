import { lambdaClient } from '@/libs/trpc/client';
import { type PlatformCapabilities } from '@/types/platform/capabilities';
import { type PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';
import { platformPublicSnapshotSchema } from '@/types/platform/publicSnapshot';
import { type SidebarLayoutPolicy } from '@/types/platform/sidebarLayout';

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
): Promise<PlatformPublicSnapshot> => platformPublicSnapshotSchema.parse(await query());

export const fetchPlatformSidebarLayoutPolicy = async (
  query: () => Promise<SidebarLayoutPolicy> = () => lambdaClient.platform.getSidebarLayout.query(),
): Promise<SidebarLayoutPolicy> => query();
