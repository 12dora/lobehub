/**
 * Resolve the provider settings route base for the current SPA location.
 * User settings: `/settings/provider`
 * Admin parity:  `/admin/ai/providers`
 */
export const resolveProviderSettingsBasePath = (pathname: string): string => {
  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'admin' && pathParts[1] === 'ai' && pathParts[2] === 'providers') {
    return '/admin/ai/providers';
  }
  return '/settings/provider';
};

export const providerSettingsPath = (pathname: string, providerId: string): string => {
  const base = resolveProviderSettingsBasePath(pathname);
  return `${base}/${encodeURIComponent(providerId)}`;
};
