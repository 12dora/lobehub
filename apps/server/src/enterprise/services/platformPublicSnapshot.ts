import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { getEnterpriseFeatureFlags } from '../featureFlags';

export interface BuildPlatformPublicSnapshotInput {
  /** Published branding fields (M12). Never pass secrets here. */
  branding?: {
    logoUrl?: string | null;
    platformName?: string | null;
    revision?: string | null;
  };
  configRevision?: string;
  flags?: EnterpriseFeatureFlags;
  /** Whether a published work-account IdP is active (M11). */
  workAccountEnabled?: boolean;
}

/**
 * Public branding / login snapshot for anonymous and authenticated clients.
 * No secrets, no admin capability detail, no role lists.
 */
export const buildPlatformPublicSnapshot = (
  input: BuildPlatformPublicSnapshotInput = {},
): PlatformPublicSnapshot => {
  const flags = input.flags ?? getEnterpriseFeatureFlags();
  const brandingOn = flags.ENABLE_RUNTIME_BRANDING;
  const oidcOn = flags.ENABLE_DATABASE_OIDC;

  return {
    brandingRevision: brandingOn ? (input.branding?.revision ?? null) : null,
    configRevision: input.configRevision ?? DISABLED_PLATFORM_PUBLIC_SNAPSHOT.configRevision,
    login: {
      // Work-account button only when OIDC feature is on AND a published IdP exists.
      workAccountEnabled: oidcOn && Boolean(input.workAccountEnabled),
    },
    logoUrl: brandingOn ? (input.branding?.logoUrl ?? null) : null,
    platformName: brandingOn ? (input.branding?.platformName ?? null) : null,
  };
};

export const getDisabledPlatformPublicSnapshot = (): PlatformPublicSnapshot => ({
  ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  login: { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT.login },
});
