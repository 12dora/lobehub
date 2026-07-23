import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';

export { formatAdminDateTime };

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
