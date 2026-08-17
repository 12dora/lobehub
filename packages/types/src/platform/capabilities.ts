/**
 * Public platform capability snapshot for clients.
 *
 * Security (M00):
 * - No role lists, secrets, or internal config values.
 * - `adminAccess` is a boolean only; permission detail stays on admin.auth APIs (M02).
 * - Clients must not infer authorization from NEXT_PUBLIC_* env vars.
 */
import type { PlatformModuleStateMap } from '@/const/platform/modules';

// Value imports must be relative: packages/types vitest does not resolve `@/const/*`.
import { ALL_MODULES_ENABLED } from '../../../const/src/platform/modules';

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
  /**
   * Whether the platform AI catalog currently OVERRIDES users' own provider configuration
   * (runtime state, settings model list, chat credentials, published-model allowlist).
   *
   * True only for `ENABLE_PLATFORM_MANAGED_AI` + a PUBLISHED `aiProviders`
   * `{managed: true, enforcementMode: 'enforced'}` policy — the server-side
   * `isPlatformAiTakeoverActive` predicate. Distinct from
   * `managedResources.aiProviders`, which is also true for `ui-only` (UI blocked, runtime NOT
   * taken over). Admin surfaces use it to tell operators whether a shared account is live.
   */
  aiTakeover: boolean;
  brandingRevision: string | null;
  /**
   * Opaque aggregate revision for client cache keys.
   * Never carries secrets or full policy payloads.
   */
  configRevision: string;
  features: PlatformFeatureCapabilities;
  managedResources: ManagedResourcesCapabilities;
  /**
   * Deployment-level module on/off map. A disabled snapshot must stay fail-open
   * (`ALL_MODULES_ENABLED`) so a missing field never hides surfaces.
   */
  modules: PlatformModuleStateMap;
  settingsRevision: string | null;
  userSettingsPolicyEnabled: boolean;
}

/** Safe empty snapshot when all enterprise flags are off. */
export const DISABLED_PLATFORM_CAPABILITIES: PlatformCapabilities = {
  adminAccess: false,
  aiTakeover: false,
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
  modules: ALL_MODULES_ENABLED,
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
