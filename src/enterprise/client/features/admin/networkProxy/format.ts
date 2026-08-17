import type { SubscriptionTraffic } from '@/types/platform/networkProxy';

const EM_DASH = '—';

/** Traffic / size in binary units. Kept local (not `formatSize`) so 0 renders as `0 B`, not `--`. */
export const formatBytes = (bytes: number | null | undefined): string => {
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

/** `1234` → `1234 ms`; null (never measured) → `—`. */
export const formatDelay = (delayMs: number | null | undefined): string =>
  delayMs === null || delayMs === undefined || !Number.isFinite(delayMs)
    ? EM_DASH
    : `${Math.round(delayMs)} ms`;

/** ISO string → locale date-time; invalid / null → `—`. */
export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleString();
};

export type IntervalUnit = 'day' | 'hour' | 'minute';

export interface IntervalDescriptor {
  unit: IntervalUnit;
  value: number;
}

/**
 * Seconds → the unit an admin would say out loud, as data rather than text: the unit name is a
 * translated string, so the subscription interval column is not half English under zh-CN.
 */
export const describeInterval = (seconds: number | null | undefined): IntervalDescriptor | null => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 3600) return { unit: 'minute', value: Math.round(seconds / 60) };
  if (seconds < 86_400) return { unit: 'hour', value: Math.round(seconds / 3600) };
  return { unit: 'day', value: Math.round(seconds / 86_400) };
};

export interface SubscriptionTrafficSummary {
  /** `null` when the subscription reports no quota at all. */
  expireAt: string | null;
  ratio: number | null;
  text: string;
}

/**
 * `used / total`, plus the expiry the provider advertised. Subscriptions that publish no
 * `subscription-userinfo` header get an em dash rather than a fabricated 0.
 */
export const summarizeTraffic = (
  traffic: SubscriptionTraffic | null | undefined,
): SubscriptionTrafficSummary => {
  if (!traffic) return { expireAt: null, ratio: null, text: EM_DASH };
  const used = (traffic.upload ?? 0) + (traffic.download ?? 0);
  const total = traffic.total ?? null;
  const hasUsage = traffic.upload !== null || traffic.download !== null;
  if (!hasUsage && total === null)
    return { expireAt: traffic.expireAt, ratio: null, text: EM_DASH };
  return {
    expireAt: traffic.expireAt,
    ratio: total && total > 0 ? Math.min(1, used / total) : null,
    text: total ? `${formatBytes(used)} / ${formatBytes(total)}` : formatBytes(used),
  };
};

/** First 12 hex chars — what an operator can eyeball against a published digest. */
export const shortDigest = (sha256: string | null | undefined): string =>
  sha256 ? sha256.slice(0, 12) : EM_DASH;

/** Instance ids are opaque `pinst_…`; the table only needs enough to tell rows apart. */
export const shortInstanceId = (instanceId: string): string =>
  instanceId.length <= 14 ? instanceId : `${instanceId.slice(0, 12)}…`;

export { EM_DASH };
