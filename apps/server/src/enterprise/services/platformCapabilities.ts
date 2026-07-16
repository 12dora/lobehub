import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type {
  ManagedResourcesCapabilities,
  PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES_FORBIDDEN_KEYS,
} from '@/types/platform/capabilities';

import { getEnterpriseFeatureFlags } from '../featureFlags';

export interface BuildPlatformCapabilitiesInput {
  /**
   * Whether the authenticated user may open admin (RBAC).
   * M00 has no real RBAC yet — always false until M02.
   */
  adminAccess?: boolean;
  /** Effective runtime enforcement booleans; no draft policy detail is exposed. */
  enforcedManagedResources?: ManagedResourcesCapabilities;
  flags?: EnterpriseFeatureFlags;
  /** Published, policy-resolved booleans. Draft/mode/readiness are never exposed. */
  managedResources?: ManagedResourcesCapabilities;
  /**
   * Optional published revisions from M01 stores.
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

  // Until M02 wires real RBAC, adminAccess is always false even if the flag is on.
  const adminAccess = Boolean(input.adminAccess) && adminFeatureOn;

  return {
    adminAccess,
    brandingRevision: input.revisions?.brandingRevision ?? null,
    configRevision:
      input.revisions?.configRevision ?? DISABLED_PLATFORM_CAPABILITIES.configRevision,
    features: {
      databaseOidc: flags.ENABLE_DATABASE_OIDC,
      platformAdmin: adminFeatureOn,
      runtimeBranding: flags.ENABLE_RUNTIME_BRANDING,
    },
    enforcedManagedResources: input.enforcedManagedResources ?? {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
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

/** Default closed snapshot — used when flags are off. */
export const getDisabledPlatformCapabilities = (): PlatformCapabilities => ({
  ...DISABLED_PLATFORM_CAPABILITIES,
  features: { ...DISABLED_PLATFORM_CAPABILITIES.features },
  enforcedManagedResources: { ...DISABLED_PLATFORM_CAPABILITIES.enforcedManagedResources },
  managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources },
});

/**
 * Runtime assertion helper for tests / redaction guards.
 * Returns forbidden key paths found in a payload (case-insensitive leaf names).
 */
export const findForbiddenCapabilityKeys = (payload: unknown): string[] => {
  const found: string[] = [];

  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const lower = key.toLowerCase();
      if (
        PLATFORM_CAPABILITIES_FORBIDDEN_KEYS.some((forbidden) => lower === forbidden.toLowerCase())
      ) {
        found.push(nextPath);
      }
      walk(child, nextPath);
    }
  };

  walk(payload, '');
  return found;
};
