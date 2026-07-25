/**
 * Shared manifest / principal types for enterprise-admin seed, CAS, and cleanup.
 */
export interface SuitePrincipal {
  accountId: string;
  email: string;
  fullName: string;
  id: string;
  password: string;
  roleLabel: 'ordinary' | 'owner' | 'super_admin' | 'auditor';
  username: string;
}

export interface SuiteSeed {
  auditor: SuitePrincipal;
  namespace: string;
  ordinary: SuitePrincipal;
  owner: SuitePrincipal;
  superAdmin: SuitePrincipal;
  workspaceId: string;
  workspaceSlug: string;
}

export interface ManagedPolicyRow {
  config: string;
  enforcement: string;
  id: string;
  resource: string;
  revision: number;
  status: string;
}

export interface RolePermissionLink {
  permissionCode: string;
  permissionId: string;
  roleId: string;
  roleName: string;
}

/**
 * Canonical suite-written permission row — every stored column including
 * default/generated timestamps. Timestamps are captured as ISO strings from DB.
 */
export interface PlatformPermissionRow {
  category: string;
  code: string;
  createdAt: string;
  description: string;
  fingerprint: string;
  id: string;
  isActive: boolean;
  name: string;
  updatedAt: string;
}

/**
 * Canonical suite-written platform role row — every stored column including
 * metadata (stable JSON) and timestamps.
 */
export interface PlatformRoleRow {
  createdAt: string;
  description: string;
  displayName: string;
  fingerprint: string;
  id: string;
  isActive: boolean;
  isSystem: boolean;
  /** Canonical JSON text (jsonb_strip_nulls + sorted keys via JSON.stringify of parsed object). */
  metadata: string;
  name: string;
  updatedAt: string;
  /** Always null for platform roles owned by this suite. */
  workspaceId: null;
}

/** Optional hooks for deterministic concurrency tests (barriers after FOR UPDATE). */
export interface CasRestoreHooks {
  afterPermissionLocked?: (permissionId: string) => Promise<void>;
  afterRoleLocked?: (roleId: string) => Promise<void>;
  /** Pool application_name for pg_stat_activity wait observation in races. */
  applicationName?: string;
}

/** Complete suite-owned role_permission row after-state (every stored column). */
export interface SuiteRolePermissionLink {
  createdAt: string;
  fingerprint: string;
  permissionCode: string;
  permissionId: string;
  roleId: string;
  roleName: string;
}

/** Complete suite-owned user_role row after-state (every stored column). */
export interface SuiteUserRoleLink {
  createdAt: string;
  expiresAt: null | string;
  fingerprint: string;
  id: string;
  roleId: string;
  userId: string;
  workspaceId: null | string;
}

/**
 * Explicit commit state machine — never infer "not committed" after COMMIT is issued.
 * ambiguous: COMMIT timed out/rejected after start; journal kept; reconcile required.
 */
export type CommitPhase =
  | 'notStarted' // pre-send; no COMMIT SQL yet
  | 'commitIssued' // COMMIT query sent, still in-flight or outcome not yet armed
  | 'committed' // known successful commit
  | 'rolledBack' // known rollback / no pollution
  | 'ambiguous'; // query finished without client certainty; journal kept until reconcile

/** Full global digest used for before/after equality. */
export interface GlobalDbDigest {
  managedPolicies: ManagedPolicyRow[];
  platformPermissions: Array<{ code: string; id: string }>;
  platformRolePermissions: RolePermissionLink[];
  platformRoles: Array<{ id: string; name: string }>;
}

/**
 * Suite-written after-manifest + created-row ownership for true CAS restore.
 * Every created row/link stores full suite-written after state + fingerprint.
 * Delete only when current still equals that after state; foreign deps → conflict.
 */
export interface SuiteGlobalWriteManifest {
  /** Full global snapshot immediately after suite seed commit. */
  after: GlobalDbDigest;
  before: GlobalDbDigest;
  /** Suite-created permissions with complete after-state + fingerprint. */
  createdPermissions: PlatformPermissionRow[];
  /** Suite-created managed policies with full after row. */
  createdPolicies: ManagedPolicyRow[];
  /**
   * Suite-created role↔permission links ONLY from INSERT…RETURNING (never global diff).
   * Full after-state including created_at for CAS delete.
   */
  createdRolePermissionKeys: SuiteRolePermissionLink[];
  /** Suite-created platform roles with complete after-state + fingerprint. */
  createdRoles: PlatformRoleRow[];
  /**
   * Suite-created user↔role links ONLY from INSERT…RETURNING (never global diff).
   * Full after-state including created_at for CAS delete.
   */
  createdUserRoles: SuiteUserRoleLink[];
  /** Policies that existed before and were mutated by this suite (CAS target). */
  mutatedPolicies: Array<{
    after: ManagedPolicyRow;
    before: ManagedPolicyRow;
  }>;
}
