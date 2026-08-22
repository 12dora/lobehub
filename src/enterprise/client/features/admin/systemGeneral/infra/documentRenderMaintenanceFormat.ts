/** The em dash every "never measured" cell on the document-render panel falls back to. */
export const EM_DASH = '—';

/**
 * Binary units, kept local rather than reusing `formatSize`: a fresh deployment legitimately stores
 * zero bytes of artifacts, and `0 B` is an answer while `--` reads like a broken probe.
 */
export const formatArtifactBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EM_DASH;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

/** `12` → `12`; null (the sweep has never run) → `—`. */
export const formatCount = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? EM_DASH : String(value);

export interface RelativeLabel {
  /** Interpolation value for the plural-ish keys; absent for `justNow`. */
  count?: number;
  key: 'days' | 'hours' | 'justNow' | 'minutes';
}

/**
 * A timestamp bucketed into the unit an operator would say out loud, returned as data so the label
 * itself stays translatable. `null` means "no timestamp at all" — the caller renders "never".
 */
export const relativeLabel = (
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): RelativeLabel | null => {
  if (!iso) return null;
  const parsed = new Date(iso).getTime();
  if (Number.isNaN(parsed)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - parsed) / 60_000);
  if (minutes < 1) return { key: 'justNow' };
  if (minutes < 60) return { count: minutes, key: 'minutes' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { count: hours, key: 'hours' };
  return { count: Math.floor(hours / 24), key: 'days' };
};

/** ISO → the operator's own locale; unparsable or missing → `—`. */
export const formatAbsolute = (iso: string | null | undefined): string => {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? EM_DASH : date.toLocaleString();
};
