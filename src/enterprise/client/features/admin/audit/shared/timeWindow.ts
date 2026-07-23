/** Default list/export window: last 7 days (inclusive start, exclusive end). */
export const DEFAULT_AUDIT_WINDOW_DAYS = 7;

export interface AuditTimeWindow {
  from: Date;
  to: Date;
}

/**
 * Build a half-open window [from, to) ending at "now" (or `end`).
 * `from` is start-of-day aligned for nicer pickers when `alignStartOfDay` is true.
 */
export const getDefaultAuditTimeWindow = (
  days: number = DEFAULT_AUDIT_WINDOW_DAYS,
  end: Date = new Date(),
  options?: { alignStartOfDay?: boolean },
): AuditTimeWindow => {
  const to = new Date(end.getTime());
  const from = new Date(to.getTime());
  from.setDate(from.getDate() - days);
  if (options?.alignStartOfDay !== false) {
    from.setHours(0, 0, 0, 0);
  }
  return { from, to };
};

/** Serialize a Date for query params / filter snapshots. */
export const toIsoOrUndefined = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
};

/** Parse ISO / Date-like string; returns undefined when invalid. */
export const parseAuditDate = (value: string | null | undefined): Date | undefined => {
  if (!value?.trim()) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
};

/** Human-readable byte size (B / KB / MB / GB). */
export const formatAuditBytes = (bytes: number | null | undefined): string => {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};
