export type AdminResourceStatus =
  'draft' | 'published' | 'pending' | 'disabled' | 'archived' | 'error' | 'unknown';

export type AdminStatusLabelKey =
  | 'primitives.status.archived'
  | 'primitives.status.disabled'
  | 'primitives.status.draft'
  | 'primitives.status.error'
  | 'primitives.status.pending'
  | 'primitives.status.published'
  | 'primitives.status.unknown';

export interface AdminStatusPresentation {
  /** Tag color token accepted by @lobehub/ui Tag */
  color: 'default' | 'success' | 'warning' | 'error' | 'info';
  /** lucide icon name key for mapping in the component */
  icon: 'file' | 'check' | 'clock' | 'ban' | 'archive' | 'alert' | 'help';
  /** i18n key under admin namespace */
  labelKey: AdminStatusLabelKey;
  status: AdminResourceStatus;
}

const STATUS_MAP: Record<AdminResourceStatus, Omit<AdminStatusPresentation, 'status'>> = {
  archived: { color: 'default', icon: 'archive', labelKey: 'primitives.status.archived' },
  disabled: { color: 'default', icon: 'ban', labelKey: 'primitives.status.disabled' },
  draft: { color: 'warning', icon: 'file', labelKey: 'primitives.status.draft' },
  error: { color: 'error', icon: 'alert', labelKey: 'primitives.status.error' },
  pending: { color: 'info', icon: 'clock', labelKey: 'primitives.status.pending' },
  published: { color: 'success', icon: 'check', labelKey: 'primitives.status.published' },
  unknown: { color: 'default', icon: 'help', labelKey: 'primitives.status.unknown' },
};

export const normalizeAdminStatus = (raw: string | null | undefined): AdminResourceStatus => {
  if (!raw) return 'unknown';
  const key = raw.trim().toLowerCase();
  if (key in STATUS_MAP) return key as AdminResourceStatus;
  return 'unknown';
};

export const getAdminStatusPresentation = (
  raw: string | null | undefined,
): AdminStatusPresentation => {
  const status = normalizeAdminStatus(raw);
  return { status, ...STATUS_MAP[status] };
};
