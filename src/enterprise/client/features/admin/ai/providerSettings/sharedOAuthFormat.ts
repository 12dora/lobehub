export const ADMIN_SHARED_OAUTH_STATUS_KEY = 'admin.aiProviderOAuth.getConnectionStatus' as const;

export const buildAdminSharedOAuthStatusKey = (providerId: string) =>
  [ADMIN_SHARED_OAUTH_STATUS_KEY, providerId] as const;

/** Vault stores epoch millis as a string; anything unparsable is treated as unknown. */
export const formatExpiry = (expiresAt: string | null): string | undefined => {
  if (!expiresAt) return undefined;
  const millis = Number(expiresAt);
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return new Date(millis).toLocaleString();
};
