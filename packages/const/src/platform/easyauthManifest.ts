/**
 * EasyAuth application descriptor + manifest for AIHub (app_key=aihub).
 * Pure data builder — no secrets.
 */
import { EASYAUTH_APP_KEY, EASYAUTH_DESCRIPTOR_VERSION } from './easyauth';
import { AIHUB_ACCESS_PERMISSION } from './permissions';
import {
  EASYAUTH_MANAGED_ROLES,
  type EasyauthManagedRoleName,
  PLATFORM_ROLE_DESCRIPTIONS,
  PLATFORM_ROLE_DISPLAY_NAMES,
  PLATFORM_SYSTEM_ROLES,
} from './roles';

/**
 * EasyAuth catalog is **role-package first** (M02 plan §6).
 * We publish aihub.access + role marker permissions + authorization_groups;
 * fine-grained platform_* codes are NOT published (sync only maps role packages).
 */
const permissionDisplayName = (code: string, lang: 'zh' | 'en'): string => {
  if (lang === 'zh') {
    if (code === AIHUB_ACCESS_PERMISSION) return 'AIHub 基础访问';
    if (code.startsWith('aihub.role.')) return code.replace('aihub.role.', '角色 · ');
    return code;
  }
  if (code === AIHUB_ACCESS_PERMISSION) return 'AIHub Base Access';
  if (code.startsWith('aihub.role.')) return code.replace('aihub.role.', 'Role · ');
  return code;
};

export interface BuildEasyauthManifestOptions {
  schemaVersion?: number;
}

export const buildEasyauthManifest = (options: BuildEasyauthManifestOptions = {}) => {
  const schemaVersion = options.schemaVersion ?? 1;

  const scopes = [
    {
      description: 'Platform-wide scope',
      display_order: 10,
      is_active: true,
      key: 'ALL',
      name: '全部',
    },
  ];

  const permission_groups = [
    {
      description: '',
      display_order: 10,
      is_active: true,
      key: 'access',
      name: '访问',
      parent_key: '',
    },
    {
      description: '',
      display_order: 20,
      is_active: true,
      key: 'roles',
      name: '角色包',
      parent_key: '',
    },
  ];

  const accessPermission = {
    description: 'Use AIHub after Authentik login',
    group_key: 'access',
    is_active: true,
    key: AIHUB_ACCESS_PERMISSION,
    name: permissionDisplayName(AIHUB_ACCESS_PERMISSION, 'zh'),
    name_en: permissionDisplayName(AIHUB_ACCESS_PERMISSION, 'en'),
    risk_level: 'standard' as const,
    supported_scopes: ['ALL'],
  };

  const rolePermissions = EASYAUTH_MANAGED_ROLES.filter(
    (r) => r !== PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
  ).map((roleName) => ({
    description: PLATFORM_ROLE_DESCRIPTIONS[roleName],
    group_key: 'roles',
    is_active: true,
    key: `aihub.role.${roleName}`,
    name: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
    name_en: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
    risk_level: 'high' as const,
    supported_scopes: ['ALL'],
  }));

  // Role packages only — fine-grained platform_* codes are not published (M4).
  const permissions = [accessPermission, ...rolePermissions];

  const authorization_groups = EASYAUTH_MANAGED_ROLES.map((roleName: EasyauthManagedRoleName) => {
    const grants =
      roleName === PLATFORM_SYSTEM_ROLES.PLATFORM_USER
        ? [{ is_active: true, permission: AIHUB_ACCESS_PERMISSION, scope: 'ALL' }]
        : [
            { is_active: true, permission: AIHUB_ACCESS_PERMISSION, scope: 'ALL' },
            { is_active: true, permission: `aihub.role.${roleName}`, scope: 'ALL' },
          ];

    return {
      description: PLATFORM_ROLE_DESCRIPTIONS[roleName],
      grants,
      is_active: true,
      key: roleName,
      kind: 'role' as const,
      name: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
      requestable: true,
    };
  });
  const approval_rules = authorization_groups.map((group) => ({
    is_active: true,
    target_key: group.key,
    target_type: 'authorization_group' as const,
  }));

  return {
    app: {
      app_key: EASYAUTH_APP_KEY,
      description: 'AIHub enterprise AI workspace',
      is_active: true,
      name: 'AIHub',
    },
    approval_rules,
    authorization_groups,
    permission_groups,
    permissions,
    schema_version: schemaVersion,
    scopes,
  };
};

export const buildEasyauthDescriptor = (options: BuildEasyauthManifestOptions = {}) => {
  const manifest = buildEasyauthManifest(options);
  return {
    app: {
      app_key: manifest.app.app_key,
      description: manifest.app.description,
      name: manifest.app.name,
    },
    descriptor_version: EASYAUTH_DESCRIPTOR_VERSION,
    manifest,
    sdk: {
      name: 'aihub-easyauth-integration',
      version: '0.1.0',
    },
  };
};
