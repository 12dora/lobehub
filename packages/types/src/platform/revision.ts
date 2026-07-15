/**
 * Type contract for platform config revisions.
 * Physical table / schema is owned by M01 — do not create tables here.
 */

export const PLATFORM_RESOURCE_TYPES = [
  'settings',
  'ai_catalog',
  'skill_catalog',
  'connector_catalog',
  'agent_catalog',
  'identity',
  'branding',
  'managed_policy',
] as const;

export type PlatformResourceType = (typeof PLATFORM_RESOURCE_TYPES)[number];

/**
 * Logical revision row for a published platform resource.
 * Mirrors intended `platform_config_revision` / resource revision semantics (M01).
 */
export interface PlatformConfigRevision {
  /** Optional integrity checksum of the published payload (no secret material). */
  checksum?: string;
  resourceId: string;
  resourceType: PlatformResourceType;
  /** Monotonic revision number starting at 1 when published. */
  revision: number;
  updatedAt?: string;
}

export interface PlatformRevisionBundle {
  agentCatalogRevision: string | null;
  aiCatalogRevision: string | null;
  brandingRevision: string | null;
  /**
   * Aggregate revision string for cache invalidation (e.g. joined counters).
   */
  configRevision: string;
  connectorCatalogRevision: string | null;
  identityRevision: string | null;
  settingsRevision: string | null;
  skillCatalogRevision: string | null;
}

export const EMPTY_PLATFORM_REVISION_BUNDLE: PlatformRevisionBundle = {
  agentCatalogRevision: null,
  aiCatalogRevision: null,
  brandingRevision: null,
  configRevision: '0',
  connectorCatalogRevision: null,
  identityRevision: null,
  settingsRevision: null,
  skillCatalogRevision: null,
};
