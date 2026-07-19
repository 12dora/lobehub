import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { PlatformBrandingPublished } from '@/types/platform/branding';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
  platformPublicSnapshotSchema,
} from '@/types/platform/publicSnapshot';

import { getEnterpriseFeatureFlags } from '../featureFlags';

export interface BuildPlatformPublicSnapshotInput {
  /** Published branding fields (M12). Never pass secrets here. */
  branding?: PlatformBrandingPublished | null;
  /**
   * Effective revision for every public configuration domain included by the caller.
   * When omitted, the Published branding revision is the public revision authority.
   */
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

  const branding = brandingOn ? (input.branding ?? null) : null;
  const configRevision =
    input.configRevision ?? branding?.revision ?? DISABLED_PLATFORM_PUBLIC_SNAPSHOT.configRevision;

  return platformPublicSnapshotSchema.parse({
    branding,
    brandingRevision: branding?.revision ?? null,
    configRevision,
    login: {
      // Work-account button only when OIDC feature is on AND a published IdP exists.
      workAccountEnabled: oidcOn && Boolean(input.workAccountEnabled),
    },
    logoUrl: branding?.logoUrl ?? null,
    platformName: branding?.name ?? null,
  });
};

export const getDisabledPlatformPublicSnapshot = (): PlatformPublicSnapshot => ({
  ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  branding: null,
  login: { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT.login },
});
