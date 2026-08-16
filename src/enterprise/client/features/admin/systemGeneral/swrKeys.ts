export const ADMIN_SYSTEM_INFRA_SETTINGS_KEY = 'admin.system.getInfraSettings';

export const buildAdminInfraSettingsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_INFRA_SETTINGS_KEY] as const) : null;
