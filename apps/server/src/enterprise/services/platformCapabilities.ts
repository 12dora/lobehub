import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type {
  ManagedResourcesCapabilities,
  PlatformCapabilities,
} from '@/types/platform/capabilities';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import { getEnterpriseFeatureFlags } from '../featureFlags';

export interface BuildPlatformCapabilitiesInput {
  /**
   * Whether the authenticated user may open admin.
   * Callers derive this from the platform permission contract
   * (e.g. router-resolved RBAC); this builder only gates it on ENABLE_PLATFORM_ADMIN.
   */
  adminAccess?: boolean;
  /**
   * Server-resolved platform-AI takeover (`isPlatformAiTakeoverActive`). Requires
   * ENABLE_PLATFORM_MANAGED_AI, so it is forced false when the flag is off.
   */
  aiTakeover?: boolean;
  flags?: EnterpriseFeatureFlags;
  /** Published, policy-resolved booleans. Draft/mode/readiness are never exposed. */
  managedResources?: ManagedResourcesCapabilities;
  /**
   * Optional published revisions from platform stores.
   * When absent, revisions stay null / '0'.
   */
  revisions?: {
    brandingRevision?: string | null;
    configRevision?: string;
    settingsRevision?: string | null;
  };
}

/**
 * Build a public capability snapshot for the current principal.
 * Must not include roles, secrets, or internal config values.
 */
export const buildPlatformCapabilities = (
  input: BuildPlatformCapabilitiesInput = {},
): PlatformCapabilities => {
  const flags = input.flags ?? getEnterpriseFeatureFlags();
  const adminFeatureOn = flags.ENABLE_PLATFORM_ADMIN;

  // adminAccess requires both the platform-admin feature flag and permission-derived access.
  const adminAccess = Boolean(input.adminAccess) && adminFeatureOn;

  return {
    adminAccess,
    aiTakeover: Boolean(input.aiTakeover) && flags.ENABLE_PLATFORM_MANAGED_AI,
    brandingRevision: input.revisions?.brandingRevision ?? null,
    configRevision:
      input.revisions?.configRevision ?? DISABLED_PLATFORM_CAPABILITIES.configRevision,
    features: {
      databaseOidc: flags.ENABLE_DATABASE_OIDC,
      platformAdmin: adminFeatureOn,
      runtimeBranding: flags.ENABLE_RUNTIME_BRANDING,
    },
    managedResources: input.managedResources ?? {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
    },
    settingsRevision: input.revisions?.settingsRevision ?? null,
    userSettingsPolicyEnabled: flags.ENABLE_PLATFORM_SETTINGS_POLICY,
  };
};
