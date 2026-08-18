/**
 * Platform permission codes (catalog only — RBAC enforcement is M02).
 * Scope must match global platform resources (`workspace_id IS NULL`).
 *
 * Format: platform_<resource>:<action>:all
 */
export const PLATFORM_PERMISSIONS = {
  ADMIN_ACCESS: 'platform_admin:access:all',

  USER_READ: 'platform_user:read:all',
  USER_CREATE: 'platform_user:create:all',
  // No platform_user:update:all — user mutations are specialized
  // (ban/delete/session/role/credential). Re-introduce USER_UPDATE only when an
  // explicit update procedure enforces it.
  USER_BAN: 'platform_user:ban:all',
  USER_DELETE: 'platform_user:delete:all',
  USER_SESSION_REVOKE: 'platform_user:session_revoke:all',
  USER_ROLE_MANAGE: 'platform_user:role_manage:all',
  /** Admin-set password and admin-disable 2FA / passkeys — takeover of sign-in factors. */
  USER_CREDENTIAL_MANAGE: 'platform_user:credential_manage:all',

  SETTINGS_READ: 'platform_settings:read:all',
  SETTINGS_UPDATE: 'platform_settings:update:all',
  SETTINGS_PUBLISH: 'platform_settings:publish:all',

  POLICY_READ: 'platform_policy:read:all',
  POLICY_UPDATE: 'platform_policy:update:all',
  POLICY_PUBLISH: 'platform_policy:publish:all',

  AI_PROVIDER_READ: 'platform_ai_provider:read:all',
  AI_PROVIDER_CREATE: 'platform_ai_provider:create:all',
  AI_PROVIDER_UPDATE: 'platform_ai_provider:update:all',
  AI_PROVIDER_DELETE: 'platform_ai_provider:delete:all',
  AI_PROVIDER_TEST: 'platform_ai_provider:test:all',
  AI_PROVIDER_PUBLISH: 'platform_ai_provider:publish:all',

  AI_MODEL_READ: 'platform_ai_model:read:all',
  AI_MODEL_CREATE: 'platform_ai_model:create:all',
  AI_MODEL_UPDATE: 'platform_ai_model:update:all',
  AI_MODEL_DELETE: 'platform_ai_model:delete:all',
  AI_MODEL_PUBLISH: 'platform_ai_model:publish:all',

  SKILL_READ: 'platform_skill:read:all',
  SKILL_CREATE: 'platform_skill:create:all',
  SKILL_UPDATE: 'platform_skill:update:all',
  SKILL_DELETE: 'platform_skill:delete:all',
  SKILL_PUBLISH: 'platform_skill:publish:all',

  CONNECTOR_READ: 'platform_connector:read:all',
  CONNECTOR_CREATE: 'platform_connector:create:all',
  CONNECTOR_UPDATE: 'platform_connector:update:all',
  CONNECTOR_DELETE: 'platform_connector:delete:all',
  CONNECTOR_TEST: 'platform_connector:test:all',
  CONNECTOR_PUBLISH: 'platform_connector:publish:all',

  AGENT_READ: 'platform_agent:read:all',
  AGENT_CREATE: 'platform_agent:create:all',
  AGENT_UPDATE: 'platform_agent:update:all',
  AGENT_DELETE: 'platform_agent:delete:all',
  AGENT_PUBLISH: 'platform_agent:publish:all',
  AGENT_ASSIGN: 'platform_agent:assign:all',

  IDENTITY_READ: 'platform_identity:read:all',
  IDENTITY_CREATE: 'platform_identity:create:all',
  IDENTITY_UPDATE: 'platform_identity:update:all',
  IDENTITY_DELETE: 'platform_identity:delete:all',
  IDENTITY_TEST: 'platform_identity:test:all',
  IDENTITY_PUBLISH: 'platform_identity:publish:all',

  BRANDING_READ: 'platform_branding:read:all',
  BRANDING_UPDATE: 'platform_branding:update:all',
  BRANDING_PUBLISH: 'platform_branding:publish:all',

  AUDIT_READ: 'platform_audit:read:all',
  AUDIT_EXPORT: 'platform_audit:export:all',
  /**
   * Read conversation / message evidence for admin audit.
   * Not granted to the default auditor package — super_admin (and explicit grants) only.
   */
  AUDIT_CONVERSATION_READ: 'platform_audit:conversation_read:all',
  /** Update platform audit policy (content access, retention windows, etc.). */
  AUDIT_POLICY_UPDATE: 'platform_audit:policy_update:all',
  /** Run retention dry-run / execute jobs (no A2 HTTP surface yet). */
  AUDIT_RETENTION_OPERATE: 'platform_audit:retention_operate:all',
  /** Create / release / list legal holds. */
  AUDIT_LEGAL_HOLD_MANAGE: 'platform_audit:legal_hold_manage:all',

  SYSTEM_READ: 'platform_system:read:all',
  SYSTEM_OPERATE: 'platform_system:operate:all',

  /** 内容审计: read overview / statistics / violation records / settings. */
  MODERATION_READ: 'platform_moderation:read:all',
  /** 内容审计: update settings, test classifier, reveal full prompt, delete records, clear cache. */
  MODERATION_MANAGE: 'platform_moderation:manage:all',

  /** 网络代理: read settings / status / subscriptions / nodes / engine logs. */
  NETWORK_PROXY_READ: 'platform_network_proxy:read:all',
  /** 网络代理: change outlet / scopes / subscriptions, install + restart the engine. super_admin only by default. */
  NETWORK_PROXY_MANAGE: 'platform_network_proxy:manage:all',

  OIDC_PUBLISH: 'platform_oidc:publish:all',

  /** Global platform data statistics (admin stats dashboard). */
  STATS_READ: 'platform_stats:read:all',

  /** Platform-owned global credentials (admin AI infrastructure). */
  CRED_READ: 'platform_credential:read:all',
  CRED_CREATE: 'platform_credential:create:all',
  CRED_UPDATE: 'platform_credential:update:all',
  CRED_DELETE: 'platform_credential:delete:all',

  /** Role assignment (admin.roles). */
  ROLE_READ: 'platform_role:read:all',
  ROLE_UPDATE: 'platform_role:update:all',
} as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

export const PLATFORM_PERMISSION_LIST = Object.values(PLATFORM_PERMISSIONS);
