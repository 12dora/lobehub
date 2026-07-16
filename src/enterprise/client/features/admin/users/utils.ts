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
  return 'users.errors.generic';
};

export const hasPermission = (granted: readonly string[], required: string): boolean =>
  granted.includes(required);
