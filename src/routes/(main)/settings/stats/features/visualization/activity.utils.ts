import type { HeatmapsProps } from '@lobehub/charts';

import type { StatsActivityBucket } from '@/features/SettingsStats';

/**
 * How an activity series is drawn. Derived from the *span* of the selected window
 * rather than the preset key, so a custom range behaves like the preset of the same
 * length: a calendar grid is only legible from roughly three columns (~21 days) up,
 * below that bars answer "when was it busy" without looking broken.
 */
export type ActivityView = 'hour' | 'day' | 'calendar';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Windows shorter than this are drawn as hourly bars. */
const HOURLY_SPAN_MS = 48 * HOUR_MS;

/** Windows up to this length are drawn as daily bars. */
const DAILY_SPAN_MS = 14 * DAY_MS;

/**
 * Pick the rendering for a half-open `[startAt, endAt)` window.
 * Anything unparsable or empty falls back to the calendar, which is what the
 * unfiltered page has always shown.
 */
export const resolveActivityView = (startAt?: string, endAt?: string): ActivityView => {
  const start = startAt ? Date.parse(startAt) : Number.NaN;
  const end = endAt ? Date.parse(endAt) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return 'calendar';

  const span = end - start;
  if (span <= 0) return 'calendar';
  if (span < HOURLY_SPAN_MS) return 'hour';
  if (span <= DAILY_SPAN_MS) return 'day';
  return 'calendar';
};

/** The `YYYY-MM-DD` day a bucket belongs to. */
export const activityBucketDay = (bucket: string): string => bucket.slice(0, 10);

/** `M/D` for a `YYYY-MM-DD…` bucket, or `undefined` when it is not that shape. */
const formatMonthDay = (bucket: string): string | undefined => {
  const [, month, day] = activityBucketDay(bucket).split('-');
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (!monthNumber || !dayNumber) return undefined;
  return `${monthNumber}/${dayNumber}`;
};

/**
 * Short x-axis label: `HH:00` for hour buckets, `M/D` for day/week buckets.
 * Buckets are already cut in the requested zone server-side, so no conversion here.
 *
 * `withDate` prefixes hour labels with `M/D`. An hourly window may span two calendar
 * days (up to 48h), where a bare `HH:00` is both ambiguous and — for the same hour on
 * both days — a duplicate x-axis index.
 */
export const formatActivityBucketLabel = (
  bucket: string,
  view: ActivityView,
  withDate = false,
): string => {
  if (view === 'hour') {
    const hour = bucket.slice(11, 16);
    if (!hour) return bucket;
    if (!withDate) return hour;
    const monthDay = formatMonthDay(bucket);
    return monthDay ? `${monthDay} ${hour}` : hour;
  }

  return formatMonthDay(bucket) ?? bucket;
};

/** Do the buckets straddle more than one calendar day (in the display zone)? */
export const activitySpansDays = (rows?: Array<{ bucket: string }>): boolean => {
  if (!rows?.length) return false;
  const first = activityBucketDay(rows[0].bucket);
  return rows.some((row) => activityBucketDay(row.bucket) !== first);
};

/** Map the ranged series onto the calendar heatmap's `Activity` shape. */
export const toHeatmapActivities = (rows?: StatsActivityBucket[]): HeatmapsProps['data'] =>
  (rows ?? []).map((row) => ({
    count: row.count,
    date: activityBucketDay(row.bucket),
    level: row.level,
  }));

export interface ActivitySeriesSummary {
  /** Trailing consecutive active days. */
  current: number;
  /** Longest run of consecutive active days. */
  longest: number;
  /** Busiest single bucket. */
  peak: number;
}

export interface ActivitySummaryOptions {
  /**
   * Is the last day of the window today — i.e. still unfinished? Only then may a
   * zero-valued terminal day be skipped instead of ending the current streak. A
   * closed historical window that ends on an inactive day has a current streak of 0.
   */
  isTerminalDayCurrent?: boolean;
}

/**
 * Peak + streak figures for the summary strip.
 *
 * Streaks are counted over *days*, so an hourly series is collapsed by day first —
 * counting active hours as "days" would print a bigger number for a shorter window.
 */
export const summarizeActivitySeries = (
  rows?: Array<{ count: number; day: string }>,
  { isTerminalDayCurrent = false }: ActivitySummaryOptions = {},
): ActivitySeriesSummary => {
  if (!rows?.length) return { current: 0, longest: 0, peak: 0 };

  let peak = 0;
  const dayTotals = new Map<string, number>();
  for (const row of rows) {
    if (row.count > peak) peak = row.count;
    dayTotals.set(row.day, (dayTotals.get(row.day) ?? 0) + row.count);
  }

  const days = [...dayTotals.keys()].sort().map((day) => dayTotals.get(day) ?? 0);

  let longest = 0;
  let run = 0;
  for (const total of days) {
    if (total > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i] > 0) current += 1;
    else if (i === days.length - 1 && isTerminalDayCurrent) continue;
    else break;
  }

  return { current, longest, peak };
};

/** The browser's IANA zone, so hour buckets line up with the reader's clock. */
const readDisplayTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

let displayTimeZone: { value: string | undefined } | undefined;

/**
 * The browser zone, resolved once per session.
 *
 * Memoized because it both shapes the server response *and* is part of the SWR key:
 * two call sites reading it independently must agree, or a window fetched in one zone
 * could be served from cache under a key claiming another.
 */
export const resolveDisplayTimeZone = (): string | undefined => {
  displayTimeZone ??= { value: readDisplayTimeZone() };
  return displayTimeZone.value;
};

/** `YYYY-MM-DD` for the given instant in `timeZone` (browser zone when omitted). */
export const currentDayInZone = (timeZone?: string, now: Date = new Date()): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(now);
  }
};

/**
 * Is the latest day covered by `rows` the current — still unfinished — day in
 * `timeZone`? Drives {@link ActivitySummaryOptions.isTerminalDayCurrent}.
 */
export const isTerminalDayCurrent = (
  rows: Array<{ day: string }> | undefined,
  timeZone?: string,
  now: Date = new Date(),
): boolean => {
  if (!rows?.length) return false;
  let terminal = rows[0].day;
  for (const row of rows) if (row.day > terminal) terminal = row.day;
  return terminal === currentDayInZone(timeZone, now);
};
