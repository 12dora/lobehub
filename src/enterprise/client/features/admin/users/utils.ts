import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

/** Format a Date for admin tables (locale-aware, stable empty). */
export const formatAdminDateTime = (value: Date | string | null | undefined): string => {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
};

export const displayUserName = (user: {
  email?: string | null;
  fullName?: string | null;
  id: string;
  username?: string | null;
}): string => {
  return user.fullName?.trim() || user.username?.trim() || user.email?.trim() || user.id;
};

/** Map mutation errors to toast-friendly text keys under admin namespace. */
export const getAdminUsersMutationErrorKey = (error: unknown): string => {
  const mapped = mapEnterpriseError(error);
  if (mapped?.code === 'ADMIN_REAUTH_REQUIRED') return 'users.errors.reauthRequired';
  if (mapped?.code === 'PLATFORM_LAST_SUPER_ADMIN') return 'users.errors.lastSuperAdmin';
  if (mapped?.code === 'PLATFORM_PERMISSION_DENIED' || mapped?.code === 'ADMIN_ACCESS_DENIED') {
    return 'users.errors.permissionDenied';
  }
  if (mapped?.code === 'PLATFORM_NOT_FOUND') return 'users.errors.notFound';
  if (mapped?.code === 'PLATFORM_INVALID_INPUT') return 'users.errors.invalidInput';
  // Shared CAS / optimistic-lock conflict (settings, branding, audit policy, …).
  if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') return 'errors.revisionConflict';
  // Prefer domain-specific i18nKey from the mapper (e.g. legal-hold purge contention)
  // over the generic enterprise.error.* fallback / users.errors.generic.
  if (
    mapped?.i18nKey &&
    !mapped.i18nKey.startsWith('enterprise.error.') &&
    mapped.i18nKey !== 'errors.generic'
  ) {
    return mapped.i18nKey;
  }
  return 'users.errors.generic';
};

/**
 * tRPC zod input-validation failures reach the client as a TRPCClientError with
 * `data.code === 'BAD_REQUEST'` and no enterprise `errorData` body (the lambda
 * errorFormatter only attaches `errorData` when the cause carries one).
 */
const isTRPCBadRequest = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'BAD_REQUEST';
};

/**
 * Create-specific mapping layered over the shared path: the server signals rejections
 * as PLATFORM_INVALID_INPUT with a machine-readable `details.reason`.
 */
export const getAdminUsersCreateErrorKey = (error: unknown): string => {
  const mapped = mapEnterpriseError(error);
  if (mapped?.code === 'PLATFORM_INVALID_INPUT') {
    if (mapped.details?.reason === 'email_taken') return 'users.errors.emailTaken';
    if (mapped.details?.reason === 'username_taken') return 'users.errors.usernameTaken';
    if (mapped.details?.reason === 'password_auth_disabled') {
      return 'users.errors.passwordAuthDisabled';
    }
  }
  // Safety net: server-side zod rejected input the client-side mirror let through —
  // show the actionable invalid-input copy instead of the generic failure.
  if (!mapped && isTRPCBadRequest(error)) return 'users.errors.invalidInput';
  return getAdminUsersMutationErrorKey(error);
};

export const hasPermission = (granted: readonly string[], required: string): boolean =>
  granted.includes(required);

/** Better Auth credential (email/password) provider id. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

export interface UserSourceFlags {
  /** Has a local email/password account. */
  hasLocal: boolean;
  /** Has any non-credential provider (OIDC / SSO / social). */
  hasSso: boolean;
  /** Distinct non-credential provider ids (for SSO tooltip). */
  ssoProviderIds: string[];
}

/**
 * Derive local vs SSO source flags from Better Auth account provider ids.
 * `'credential'` → local; any other provider id → SSO. Both may be true when linked.
 */
export const deriveUserSources = (providerIds: readonly string[]): UserSourceFlags => {
  const ssoProviderIds = [
    ...new Set(providerIds.filter((id) => id !== CREDENTIAL_PROVIDER_ID && id.length > 0)),
  ];
  return {
    hasLocal: providerIds.includes(CREDENTIAL_PROVIDER_ID),
    hasSso: ssoProviderIds.length > 0,
    ssoProviderIds,
  };
};
