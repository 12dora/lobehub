import { PLATFORM_PERMISSIONS, type PlatformPermission } from './permissions';

/**
 * Global platform system roles (workspace_id IS NULL).
 * `super_admin` is local bootstrap / break-glass only.
 * Other packages are granted via the admin RBAC console.
 */
export const PLATFORM_SYSTEM_ROLES = {
  SUPER_ADMIN: 'super_admin',
  USER_ADMIN: 'user_admin',
  AI_ADMIN: 'ai_admin',
  IDENTITY_ADMIN: 'identity_admin',
  AUDITOR: 'auditor',
  /** Default role for any authenticated user (no admin APIs). */
  PLATFORM_USER: 'platform_user',
} as const;

export type PlatformSystemRoleName =
  (typeof PLATFORM_SYSTEM_ROLES)[keyof typeof PLATFORM_SYSTEM_ROLES];

const PLATFORM_SYSTEM_ROLE_NAME_SET = new Set<string>(Object.values(PLATFORM_SYSTEM_ROLES));

/** True when `name` is a built-in platform system role (not a custom role). */
export const isPlatformSystemRoleName = (name: string): name is PlatformSystemRoleName =>
  PLATFORM_SYSTEM_ROLE_NAME_SET.has(name);

/**
 * Stable, locale-neutral seed metadata for system roles.
 *
 * Built-in roles persist the machine `name` as `displayName` / a non-localized
 * description — never English UI copy. Client UI must resolve labels from i18n
 * keys `users.roles.*` / `users.roles.desc.*` and must not treat stored
 * displayName as a user-facing translation override for system roles.
 */
export const PLATFORM_ROLE_DISPLAY_NAMES: Record<PlatformSystemRoleName, string> = {
  [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  [PLATFORM_SYSTEM_ROLES.USER_ADMIN]: PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  [PLATFORM_SYSTEM_ROLES.AI_ADMIN]: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  [PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN]: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  [PLATFORM_SYSTEM_ROLES.AUDITOR]: PLATFORM_SYSTEM_ROLES.AUDITOR,
  [PLATFORM_SYSTEM_ROLES.PLATFORM_USER]: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
};

/** Locale-neutral seed descriptions (machine ids only — not shown as UI copy). */
export const PLATFORM_ROLE_DESCRIPTIONS: Record<PlatformSystemRoleName, string> = {
  [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  [PLATFORM_SYSTEM_ROLES.USER_ADMIN]: PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  [PLATFORM_SYSTEM_ROLES.AI_ADMIN]: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  [PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN]: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  [PLATFORM_SYSTEM_ROLES.AUDITOR]: PLATFORM_SYSTEM_ROLES.AUDITOR,
  [PLATFORM_SYSTEM_ROLES.PLATFORM_USER]: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
};

/**
 * Resolve a platform role label for UI.
 * System roles always use the i18n key; English seed metadata must never win.
 * Custom roles fall back to stored displayName / name.
 */
export const resolvePlatformRoleLabel = (
  role: { displayName?: string | null; name: string },
  t: (key: string, options?: { defaultValue?: string }) => string,
): string => {
  if (isPlatformSystemRoleName(role.name)) {
    return t(`users.roles.${role.name}`, { defaultValue: role.name });
  }
  return role.displayName?.trim() || role.name;
};

/**
 * Resolve a platform role description for UI (system roles → i18n only).
 */
export const resolvePlatformRoleDescription = (
  role: { displayName?: string | null; name: string },
  t: (key: string, options?: { defaultValue?: string }) => string,
): string => {
  if (isPlatformSystemRoleName(role.name)) {
    return t(`users.roles.desc.${role.name}`, { defaultValue: '' });
  }
  return role.displayName?.trim() || role.name;
};

const allPlatformPermissions = Object.values(PLATFORM_PERMISSIONS) as PlatformPermission[];

const readOnlyPlatformPermissions = allPlatformPermissions.filter(
  (code) =>
    code.includes(':read:') ||
    code.includes(':export:') ||
    code === PLATFORM_PERMISSIONS.ADMIN_ACCESS,
);

/**
 * Permission packages for each platform system role.
 * Source of truth for seed + matrix tests.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<
  PlatformSystemRoleName,
  readonly PlatformPermission[]
> = {
  [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]: allPlatformPermissions,

  [PLATFORM_SYSTEM_ROLES.USER_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.USER_CREATE,
    PLATFORM_PERMISSIONS.USER_BAN,
    PLATFORM_PERMISSIONS.USER_DELETE,
    PLATFORM_PERMISSIONS.USER_SESSION_REVOKE,
    PLATFORM_PERMISSIONS.USER_ROLE_MANAGE,
    PLATFORM_PERMISSIONS.ROLE_READ,
    PLATFORM_PERMISSIONS.ROLE_UPDATE,
    PLATFORM_PERMISSIONS.AUDIT_READ,
  ],

  [PLATFORM_SYSTEM_ROLES.AI_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.SETTINGS_READ,
    PLATFORM_PERMISSIONS.POLICY_READ,
    PLATFORM_PERMISSIONS.POLICY_UPDATE,
    PLATFORM_PERMISSIONS.POLICY_PUBLISH,
    PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
    PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_TEST,
    PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
    PLATFORM_PERMISSIONS.AI_MODEL_READ,
    PLATFORM_PERMISSIONS.AI_MODEL_CREATE,
    PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
    PLATFORM_PERMISSIONS.AI_MODEL_DELETE,
    PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH,
    PLATFORM_PERMISSIONS.SKILL_READ,
    PLATFORM_PERMISSIONS.SKILL_CREATE,
    PLATFORM_PERMISSIONS.SKILL_UPDATE,
    PLATFORM_PERMISSIONS.SKILL_DELETE,
    PLATFORM_PERMISSIONS.SKILL_PUBLISH,
    PLATFORM_PERMISSIONS.CONNECTOR_READ,
    PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
    PLATFORM_PERMISSIONS.CONNECTOR_DELETE,
    PLATFORM_PERMISSIONS.CONNECTOR_TEST,
    PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH,
    PLATFORM_PERMISSIONS.AGENT_READ,
    PLATFORM_PERMISSIONS.AGENT_CREATE,
    PLATFORM_PERMISSIONS.AGENT_UPDATE,
    PLATFORM_PERMISSIONS.AGENT_DELETE,
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    PLATFORM_PERMISSIONS.AGENT_ASSIGN,
    PLATFORM_PERMISSIONS.CRED_READ,
    PLATFORM_PERMISSIONS.CRED_CREATE,
    PLATFORM_PERMISSIONS.CRED_UPDATE,
    PLATFORM_PERMISSIONS.CRED_DELETE,
    PLATFORM_PERMISSIONS.AUDIT_READ,
    PLATFORM_PERMISSIONS.MODERATION_READ,
    PLATFORM_PERMISSIONS.MODERATION_MANAGE,
  ],

  [PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.IDENTITY_READ,
    PLATFORM_PERMISSIONS.IDENTITY_CREATE,
    PLATFORM_PERMISSIONS.IDENTITY_UPDATE,
    PLATFORM_PERMISSIONS.IDENTITY_DELETE,
    PLATFORM_PERMISSIONS.IDENTITY_TEST,
    PLATFORM_PERMISSIONS.IDENTITY_PUBLISH,
    PLATFORM_PERMISSIONS.OIDC_PUBLISH,
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.BRANDING_UPDATE,
    PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
    PLATFORM_PERMISSIONS.AUDIT_READ,
  ],

  [PLATFORM_SYSTEM_ROLES.AUDITOR]: [
    ...new Set([
      ...readOnlyPlatformPermissions,
      PLATFORM_PERMISSIONS.AUDIT_READ,
      PLATFORM_PERMISSIONS.AUDIT_EXPORT,
      PLATFORM_PERMISSIONS.ROLE_READ,
      PLATFORM_PERMISSIONS.SYSTEM_READ,
    ]),
  ],

  [PLATFORM_SYSTEM_ROLES.PLATFORM_USER]: [],
};
