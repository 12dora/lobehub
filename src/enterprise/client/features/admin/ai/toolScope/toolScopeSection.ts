import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';

import type { useToolScopeNotifications } from './useToolScopeNotifications';

/**
 * Shared shape of the per-view sections (skill / connector) composed by
 * `useAdminGlobalToolScope`: each one owns its catalog reads and writes, is
 * gated by `enabled` so the inactive view issues no request, and reports
 * failures through the one shared notification surface.
 */
export interface AdminToolScopeSectionParams {
  capabilities: AdminToolScopeCapabilities;
  enabled: boolean;
  notifications: ReturnType<typeof useToolScopeNotifications>;
}

/**
 * First paint only: a revalidation over already-rendered data must not flip the
 * view back to its skeleton.
 */
export const isInitialSwrLoading = (swr: { data: unknown; isLoading: boolean }): boolean =>
  Boolean(swr.isLoading && !swr.data);
