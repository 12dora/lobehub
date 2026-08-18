import dayjs from 'dayjs';

export const ADMIN_SHARED_OAUTH_STATUS_KEY = 'admin.aiProviderOAuth.getConnectionStatus' as const;

export const buildAdminSharedOAuthStatusKey = (providerId: string) =>
  [ADMIN_SHARED_OAUTH_STATUS_KEY, providerId] as const;

/**
 * One explicit shape for every timestamp on the shared-account card, in the operator's own
 * timezone: `2026/10/17 19:08:29`. `toLocaleString()` followed the OS locale instead, so the
 * two halves of a merged line ("valid until X, last renewed Y") could disagree in width and
 * ordering with the rest of the console.
 */
const TIMESTAMP_FORMAT = 'YYYY/M/D HH:mm:ss';

/** Vault stores epoch millis as a string; anything unparsable is treated as unknown. */
export const formatExpiry = (expiresAt: string | null): string | undefined => {
  if (!expiresAt) return undefined;
  const millis = Number(expiresAt);
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return dayjs(millis).format(TIMESTAMP_FORMAT);
};
