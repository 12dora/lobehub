import type { TFunction } from 'i18next';

import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';

export { formatAdminDateTime };

/**
 * Readable fallback for an audit action/target-type token that has no explicit
 * translation yet (new server enum values). Drops the leading scope segment,
 * splits dotted / camelCase / snake_case, and sentence-cases the result.
 * e.g. `admin.aiProviders.publish` → "Ai providers publish".
 */
export const humanizeAuditToken = (value: string): string => {
  const withoutScope = value.replace(/^(admin|platform|managedResource)\./, '');
  const words = withoutScope
    .replaceAll(/[._]+/g, ' ')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
};

/** Localized label for an audit `action` value with a humanized fallback. */
export const auditActionLabel = (t: TFunction<'admin'>, value: string): string =>
  value
    ? t(`audit.logs.action.${value}` as never, { defaultValue: humanizeAuditToken(value) })
    : '—';

/** Localized label for an audit `targetType` value with a humanized fallback. */
export const auditTargetTypeLabel = (t: TFunction<'admin'>, value: string): string =>
  value
    ? t(`audit.logs.targetType.${value}` as never, { defaultValue: humanizeAuditToken(value) })
    : '—';

export const displayAuditUserLabel = (user: {
  email?: string | null;
  fullName?: string | null;
  id: string;
  username?: string | null;
}): string => {
  return user.fullName?.trim() || user.username?.trim() || user.email?.trim() || user.id;
};

export const truncateText = (value: string | null | undefined, max = 80): string => {
  if (!value) return '—';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
};

export const hasPermission = (granted: readonly string[], required: string): boolean =>
  granted.includes(required);
