export const ADMIN_BROWSER_PROFILE_KEY = 'admin.browserProfile.get';
export const ADMIN_BROWSER_PROFILE_OPTIONS_KEY = 'admin.browserProfile.options';
export const ADMIN_SYSTEM_INFRA_SETTINGS_KEY = 'admin.system.getInfraSettings';

export const buildAdminBrowserProfileKey = (enabled: boolean) =>
  enabled ? ([ADMIN_BROWSER_PROFILE_KEY] as const) : null;

export const buildAdminBrowserProfileOptionsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_BROWSER_PROFILE_OPTIONS_KEY] as const) : null;

export const buildAdminInfraSettingsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_INFRA_SETTINGS_KEY] as const) : null;
