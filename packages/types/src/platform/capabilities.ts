/**
 * Public platform capability snapshot for clients.
 *
 * Security (M00):
 * - No role lists, secrets, or internal config values.
 * - `adminAccess` is a boolean only; permission detail stays on admin.auth APIs (M02).
 * - Clients must not infer authorization from NEXT_PUBLIC_* env vars.
 */

export interface ManagedResourcesCapabilities {
  agents: boolean;
  aiModels: boolean;
  aiProviders: boolean;
  connectors: boolean;
  skills: boolean;
}

export interface PlatformFeatureCapabilities {
  /** Database-backed OIDC providers are active after restart (M11). */
  databaseOidc: boolean;
  /** Admin console shell may load (still requires server-side RBAC). */
  platformAdmin: boolean;
  /** Runtime branding overrides are published (M12). */
  runtimeBranding: boolean;
}

export interface PlatformCapabilities {
  /**
   * Whether the current principal may open `/admin`.
   * Always false when platform admin flag is off or user lacks access.
   */
  adminAccess: boolean;
  brandingRevision: string | null;
  /**
   * Opaque aggregate revision for client cache keys.
   * Never carries secrets or full policy payloads.
   */
  configRevision: string;
  features: PlatformFeatureCapabilities;
  managedResources: ManagedResourcesCapabilities;
  settingsRevision: string | null;
  userSettingsPolicyEnabled: boolean;
}

/** Safe empty snapshot when all enterprise flags are off. */
export const DISABLED_PLATFORM_CAPABILITIES: PlatformCapabilities = {
  adminAccess: false,
  brandingRevision: null,
  configRevision: '0',
  features: {
    databaseOidc: false,
    platformAdmin: false,
    runtimeBranding: false,
  },
  managedResources: {
    agents: false,
    aiModels: false,
    aiProviders: false,
    connectors: false,
    skills: false,
  },
  settingsRevision: null,
  userSettingsPolicyEnabled: false,
};

/** Keys that must never appear on a capabilities payload. */
export const PLATFORM_CAPABILITIES_FORBIDDEN_KEYS = [
  'roles',
  'roleList',
  'permissions',
  'secret',
  'secrets',
  'apiKey',
  'token',
  'password',
  'clientSecret',
  'privateKey',
] as const;
