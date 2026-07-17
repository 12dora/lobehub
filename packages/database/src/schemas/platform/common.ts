/**
 * Shared lifecycle status for platform-managed publishable resources.
 * Published revisions are immutable; edits happen on draft rows only.
 */
export type PlatformResourceStatus = 'draft' | 'published' | 'archived';

/**
 * Status values stored on individual revision rows.
 * `rolled_back` marks a revision that was previously published and later rolled back from.
 */
export type PlatformRevisionStatus = PlatformResourceStatus | 'rolled_back';

/**
 * Platform resource kinds that participate in the unified revision log.
 * Domain modules own normalized current tables; this enum only scopes the revision stream.
 */
export type PlatformResourceType =
  | 'settings'
  | 'managed_policy'
  | 'provider'
  | 'model'
  | 'skill'
  | 'connector'
  | 'agent'
  | 'oidc'
  | 'branding';

/** Distribution policy for platform-pushed agents / skills. */
export type PlatformDistribution = 'mandatory' | 'default' | 'optional';

/** Job lifecycle for platform background work. */
export type PlatformJobStatus =
  'pending' | 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dead';

/** Audit outcome. */
export type PlatformAuditResult = 'success' | 'failure' | 'denied';
