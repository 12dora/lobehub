import { lambdaClient } from '@/libs/trpc/client';
import type { PlatformAgentTemplateListOutput } from '@/server/enterprise/contracts/adminAgentTemplates';
import type { PlatformTaskTemplateListOutput } from '@/server/enterprise/contracts/adminTaskTemplates';
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

/**
 * Platform-managed agent templates. `managed: false` means the flag/module is off (or the
 * policy read failed) and the caller should keep using the built-in locale examples.
 * `managed: true` with an empty list is a deliberate empty catalog.
 */
export const fetchPlatformAgentTemplates = async (
  query: () => Promise<PlatformAgentTemplateListOutput> = () =>
    lambdaClient.platform.agentTemplates.list.query(),
): Promise<PlatformAgentTemplateListOutput> => query();

/**
 * Platform-managed task templates. `managed: false` means the flag/module is off (or the
 * policy read failed) and the caller should keep using the bundled recommendations.
 * `managed: true` with an empty list is a deliberate empty catalog.
 */
export const fetchPlatformTaskTemplates = async (
  query: () => Promise<PlatformTaskTemplateListOutput> = () =>
    lambdaClient.platform.taskTemplates.list.query(),
): Promise<PlatformTaskTemplateListOutput> => query();
