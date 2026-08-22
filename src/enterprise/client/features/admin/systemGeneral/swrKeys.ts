export const ADMIN_BROWSER_PROFILE_KEY = 'admin.browserProfile.get';
export const ADMIN_BROWSER_PROFILE_OPTIONS_KEY = 'admin.browserProfile.options';
export const ADMIN_SYSTEM_INFRA_SETTINGS_KEY = 'admin.system.getInfraSettings';
export const ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY = 'admin.system.getSandboxSettings';
export const ADMIN_SYSTEM_DOCUMENT_RENDER_SETTINGS_KEY = 'admin.system.getDocumentRenderSettings';
export const ADMIN_SYSTEM_DOCUMENT_RENDER_STATUS_KEY = 'admin.system.getDocumentRenderStatus';

export const buildAdminBrowserProfileKey = (enabled: boolean) =>
  enabled ? ([ADMIN_BROWSER_PROFILE_KEY] as const) : null;

export const buildAdminBrowserProfileOptionsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_BROWSER_PROFILE_OPTIONS_KEY] as const) : null;

export const buildAdminInfraSettingsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_INFRA_SETTINGS_KEY] as const) : null;

export const buildAdminSandboxSettingsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY] as const) : null;

export const buildAdminDocumentRenderSettingsKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_DOCUMENT_RENDER_SETTINGS_KEY] as const) : null;

export const buildAdminDocumentRenderStatusKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_DOCUMENT_RENDER_STATUS_KEY] as const) : null;
