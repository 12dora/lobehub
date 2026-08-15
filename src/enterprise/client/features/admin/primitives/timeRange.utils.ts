import dayjs from 'dayjs';

/** Quick-pick keys for the admin time-range filter. `custom` is driven by two day strings. */
export type AdminTimeRangeKey = 'today' | '24h' | '7d' | '30d' | '90d' | 'custom';

export const ADMIN_TIME_RANGE_KEYS = ['today', '24h', '7d', '30d', '90d', 'custom'] as const;

export const DEFAULT_ADMIN_TIME_RANGE_KEY: AdminTimeRangeKey = '30d';

/**
 * Widest window the client will ever request. A custom range wider than this is clamped
 * to its last {@link ADMIN_TIME_RANGE_MAX_DAYS} days rather than being rejected.
 *
 * The server caps a window by *elapsed time* (`endAt - startAt <= 366 × 24h`), not by
 * calendar days, so clamping to 366 calendar days would be rejected whenever a DST
 * fall-back inside the window stretches it to 366d + 1h. 365 calendar days can never
 * exceed the server cap (365d ± 1h < 366 × 24h) — see `ADMIN_TIME_RANGE_MAX_MS`.
 */
export const ADMIN_TIME_RANGE_MAX_DAYS = 365;

/** The server's absolute ceiling, in milliseconds. Asserted by the DST regression test. */
export const ADMIN_TIME_RANGE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** Day strings (`YYYY-MM-DD`) as held in the URL for the custom picker. */
export interface AdminTimeRangeCustom {
  from?: string | null;
  to?: string | null;
}

export interface AdminTimeRangeBounds {
  /** Exclusive upper bound, ISO-8601 instant. */
  endAt: string;
  /** Effective key — falls back to the default when custom bounds are unusable. */
  key: AdminTimeRangeKey;
  /** Inclusive lower bound, ISO-8601 instant. */
  startAt: string;
}

/** Resolved range plus its localized label (built by `useAdminTimeRange`). */
export interface AdminTimeRange extends AdminTimeRangeBounds {
  label: string;
}

const PRESET_DAYS: Record<'7d' | '30d' | '90d', number> = { '30d': 30, '7d': 7, '90d': 90 };

const bounds = (
  key: AdminTimeRangeKey,
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
): AdminTimeRangeBounds => ({
  endAt: end.toDate().toISOString(),
  key,
  startAt: start.toDate().toISOString(),
});

/** `YYYY-MM-DD` only — dayjs' strict parser needs a plugin that is not installed globally. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a URL day string, rejecting days that do not exist.
 *
 * dayjs rolls impossible dates over instead of failing (`2026-02-31` → `2026-03-03`,
 * `isValid()` still true), so the only reliable check without the strict-parse plugin is
 * a round-trip through the same format.
 */
const parseDay = (value?: string | null): dayjs.Dayjs | undefined => {
  if (!value || !DAY_PATTERN.test(value)) return undefined;
  const parsed = dayjs(value);
  if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== value) return undefined;
  return parsed;
};

/** True when `value` is a real calendar day in `YYYY-MM-DD` form. */
export const isAdminTimeRangeDay = (value?: string | null): value is string =>
  Boolean(parseDay(value));

/**
 * Resolve a quick-pick key into a half-open `[startAt, endAt)` instant window.
 *
 * - `today` — local start of day → now
 * - `24h` — now minus 24 hours → now
 * - `7d` / `30d` / `90d` — start of the day N-1 days ago → now (N calendar days incl. today)
 * - `custom` — start of `from` → start of the day after `to` (end-exclusive)
 *
 * Day arithmetic goes through dayjs calendar units, so a DST transition inside the
 * window never shifts the local day boundary. Unusable custom bounds fall back to
 * the default preset so the UI never queries an inverted window.
 */
export const resolveAdminTimeRange = (
  key: AdminTimeRangeKey,
  now: Date | dayjs.Dayjs = dayjs(),
  custom?: AdminTimeRangeCustom,
): AdminTimeRangeBounds => {
  const end = dayjs(now);

  switch (key) {
    case 'today': {
      return bounds('today', end.startOf('day'), end);
    }
    case '24h': {
      return bounds('24h', end.subtract(24, 'hour'), end);
    }
    case '7d':
    case '30d':
    case '90d': {
      const days = PRESET_DAYS[key];
      return bounds(key, end.subtract(days - 1, 'day').startOf('day'), end);
    }
    case 'custom': {
      const from = parseDay(custom?.from);
      const to = parseDay(custom?.to);
      if (!from || !to) return resolveAdminTimeRange(DEFAULT_ADMIN_TIME_RANGE_KEY, now);

      const start = from.startOf('day');
      // `to` is an inclusive day in the picker; the API window is end-exclusive.
      const stop = to.startOf('day').add(1, 'day');
      if (!stop.isAfter(start)) return resolveAdminTimeRange(DEFAULT_ADMIN_TIME_RANGE_KEY, now);

      const earliest = stop.subtract(ADMIN_TIME_RANGE_MAX_DAYS, 'day');
      return bounds('custom', earliest.isAfter(start) ? earliest : start, stop);
    }
  }
};

/**
 * Compact `M/D – M/D` label for a custom window. The stored `endAt` is exclusive,
 * so the displayed end day is the day before it.
 */
export const formatCustomRangeLabel = (range: AdminTimeRangeBounds): string => {
  const start = dayjs(range.startAt);
  const end = dayjs(range.endAt).subtract(1, 'day');
  return `${start.format('M/D')} – ${end.format('M/D')}`;
};
