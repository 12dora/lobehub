import { BUILT_IN_RUNTIME_BRANDING } from '@lobechat/business-const';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import { resolveRuntimeBranding, type RuntimeBranding } from '@/types/platform/branding';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { resolvePlatformPublicSnapshot } from './resolvePublicSnapshot';

export interface ResolveServerRuntimeBrandingOptions {
  flags?: EnterpriseFeatureFlags;
  getDatabase?: () => Promise<LobeChatDatabase>;
  getPublishedBranding?: Parameters<
    typeof resolvePlatformPublicSnapshot
  >[0]['getPublishedBranding'];
}

export interface ServerRuntimeBrandingSnapshot {
  branding: RuntimeBranding;
  publicSnapshot: PlatformPublicSnapshot;
}

export const resolveServerRuntimeBrandingFromPublicSnapshot = (
  publicSnapshot: PlatformPublicSnapshot,
): RuntimeBranding =>
  resolveRuntimeBranding(publicSnapshot.branding, { ...BUILT_IN_RUNTIME_BRANDING });

export const resolveServerRuntimeBrandingSnapshot = async (
  options: ResolveServerRuntimeBrandingOptions = {},
): Promise<ServerRuntimeBrandingSnapshot> => {
  const publicSnapshot = await resolvePlatformPublicSnapshot({
    flags: options.flags ?? parseEnterpriseFeatureFlags(process.env),
    getDatabase: options.getDatabase,
    getPublishedBranding: options.getPublishedBranding,
  });

  return {
    branding: resolveServerRuntimeBrandingFromPublicSnapshot(publicSnapshot),
    publicSnapshot,
  };
};

/**
 * Request/send-time branding snapshot. Disabled, missing or failed reads resolve to the
 * immutable product fallback without throwing.
 */
export const resolveServerRuntimeBranding = async (
  options: ResolveServerRuntimeBrandingOptions = {},
): Promise<RuntimeBranding> => {
  const snapshot = await resolveServerRuntimeBrandingSnapshot(options);
  return snapshot.branding;
};
