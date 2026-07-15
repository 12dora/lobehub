/**
 * EasyAuth application descriptor + manifest for AIHub (app_key=aihub).
 * Pure data builder — no secrets.
 */
import { EASYAUTH_APP_KEY, EASYAUTH_DESCRIPTOR_VERSION } from './easyauth';
import { AIHUB_ACCESS_PERMISSION, PLATFORM_PERMISSION_LIST } from './permissions';
import {
  EASYAUTH_MANAGED_ROLES,
  type EasyauthManagedRoleName,
  PLATFORM_ROLE_DESCRIPTIONS,
  PLATFORM_ROLE_DISPLAY_NAMES,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SYSTEM_ROLES,
} from './roles';

const permissionDisplayName = (code: string, lang: 'zh' | 'en'): string => {
  const base = code.replace(/:all$/, '').replaceAll('_', ' ').replaceAll(':', ' ');
  if (lang === 'zh') {
    if (code === AIHUB_ACCESS_PERMISSION) return 'AIHub 基础访问';
    if (code.startsWith('platform_admin')) return '管理后台访问';
    if (code.startsWith('platform_user')) return `用户管理 · ${base}`;
    if (code.startsWith('platform_ai')) return `AI 管理 · ${base}`;
    if (code.startsWith('platform_skill')) return `Skill 管理 · ${base}`;
    if (code.startsWith('platform_connector')) return `连接器管理 · ${base}`;
    if (code.startsWith('platform_agent')) return `Agent 管理 · ${base}`;
    if (code.startsWith('platform_identity') || code.startsWith('platform_oidc'))
      return `身份管理 · ${base}`;
    if (code.startsWith('platform_branding')) return `品牌管理 · ${base}`;
    if (code.startsWith('platform_audit')) return `审计 · ${base}`;
    if (code.startsWith('platform_system')) return `系统 · ${base}`;
    if (code.startsWith('platform_role')) return `角色管理 · ${base}`;
    if (code.startsWith('platform_settings') || code.startsWith('platform_policy'))
      return `设置策略 · ${base}`;
    return base;
  }
  if (code === AIHUB_ACCESS_PERMISSION) return 'AIHub Base Access';
  return base
    .split(' ')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
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
      key: 'platform',
      name: '平台管理',
      parent_key: '',
    },
    {
      description: '',
      display_order: 30,
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
  ).map((roleName, index) => ({
    description: PLATFORM_ROLE_DESCRIPTIONS[roleName],
    group_key: 'roles',
    is_active: true,
    key: `aihub.role.${roleName}`,
    name: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
    name_en: PLATFORM_ROLE_DISPLAY_NAMES[roleName],
    risk_level: 'high' as const,
    supported_scopes: ['ALL'],
    // stable ordering
    _order: index,
  }));

  // Fine-grained platform codes for catalog (optional direct grants)
  const platformPermissions = PLATFORM_PERMISSION_LIST.map((code, index) => ({
    description: code,
    group_key: 'platform',
    is_active: true,
    key: code,
    name: permissionDisplayName(code, 'zh'),
    name_en: permissionDisplayName(code, 'en'),
    risk_level:
      code.includes('ban') || code.includes('delete') || code.includes('publish')
        ? ('high' as const)
        : ('standard' as const),
    supported_scopes: ['ALL'],
    _order: index,
  }));

  const permissions = [
    accessPermission,
    ...rolePermissions.map(({ _order: _, ...rest }) => rest),
    ...platformPermissions.map(({ _order: _, ...rest }) => rest),
  ];

  const authorization_groups = EASYAUTH_MANAGED_ROLES.map((roleName: EasyauthManagedRoleName) => {
    const grants =
      roleName === PLATFORM_SYSTEM_ROLES.PLATFORM_USER
        ? [{ is_active: true, permission: AIHUB_ACCESS_PERMISSION, scope: 'ALL' }]
        : [
            { is_active: true, permission: AIHUB_ACCESS_PERMISSION, scope: 'ALL' },
            { is_active: true, permission: `aihub.role.${roleName}`, scope: 'ALL' },
            ...PLATFORM_ROLE_PERMISSIONS[roleName].map((permission) => ({
              is_active: true,
              permission,
              scope: 'ALL',
            })),
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
