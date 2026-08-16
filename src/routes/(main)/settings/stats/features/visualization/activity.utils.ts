import type { HeatmapsProps } from '@lobehub/charts';

import type { StatsActivityBucket } from '@/features/SettingsStats';

/**
 * How an activity series is drawn. Derived from the *span* of the selected window
 * rather than the preset key, so a custom range behaves like the preset of the same
 * length.
 *
 * Every window keeps the same square blocks: a day-granularity window is the calendar
 * grid, scaled up so a short range does not draw as a stamp, and a sub-48h window has
 * no calendar days to fill so the very same squares are laid out as an hour strip.
 */
export type ActivityView = 'hour' | 'calendar';

const HOUR_MS = 60 * 60 * 1000;

/** Windows shorter than this are cut by hour, so they get the hour strip. */
const HOURLY_SPAN_MS = 48 * HOUR_MS;

/** Length of a half-open `[startAt, endAt)` window, or `undefined` when unusable. */
const activityWindowSpan = (startAt?: string, endAt?: string): number | undefined => {
  const start = startAt ? Date.parse(startAt) : Number.NaN;
  const end = endAt ? Date.parse(endAt) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;

  const span = end - start;
  return span > 0 ? span : undefined;
};

/**
 * Pick the rendering for a half-open `[startAt, endAt)` window.
 * Anything unparsable or empty falls back to the calendar, which is what the
 * unfiltered page has always shown.
 */
export const resolveActivityView = (startAt?: string, endAt?: string): ActivityView => {
  const span = activityWindowSpan(startAt, endAt);
  if (span === undefined) return 'calendar';
  return span < HOURLY_SPAN_MS ? 'hour' : 'calendar';
};

export interface CalendarBlockMetrics {
  blockMargin: number;
  blockRadius: number;
  blockSize: number;
  /**
   * The calendar only prints a month label once three week columns follow it, so a
   * window of a fortnight or less can never draw one and would merely reserve an
   * empty label strip above the grid.
   */
  hideMonthLabels: boolean;
}

interface CalendarBlockStep extends Omit<CalendarBlockMetrics, 'hideMonthLabels'> {
  /** Longest window, in calendar days, this step applies to. */
  maxDays: number;
}

/**
 * Block sizes by window length. The calendar is week-per-column, so a short window is
 * only a handful of columns wide — at the year-view block size a month draws as a
 * stamp marooned in the card. Growing the block keeps the grid legible; the cap stops
 * a week from turning into a wall of tiles.
 */
const DESKTOP_BLOCK_STEPS: CalendarBlockStep[] = [
  { blockMargin: 6, blockRadius: 5, blockSize: 28, maxDays: 14 },
  { blockMargin: 6, blockRadius: 4, blockSize: 24, maxDays: 35 },
  { blockMargin: 5, blockRadius: 3, blockSize: 18, maxDays: 98 },
];

const MOBILE_BLOCK_STEPS: CalendarBlockStep[] = [
  { blockMargin: 3, blockRadius: 3, blockSize: 12, maxDays: 14 },
  { blockMargin: 3, blockRadius: 2, blockSize: 10, maxDays: 35 },
  { blockMargin: 3, blockRadius: 2, blockSize: 8, maxDays: 98 },
];

/** What a full year of columns has always used — also the fallback for no window. */
const DESKTOP_YEAR_BLOCK = { blockMargin: 4, blockRadius: 2, blockSize: 14 };
const MOBILE_YEAR_BLOCK = { blockMargin: 3, blockRadius: 2, blockSize: 6 };

/** Shortest window that can print a month label at all. */
const MONTH_LABEL_MIN_DAYS = 15;

/**
 * Scale the calendar blocks to the selected window, given the *calendar days* it covers
 * (see {@link activitySeriesDays}). Called without a day count — the unfiltered year
 * view, or while the request is still in flight — it returns exactly the year-view
 * metrics, so nothing about that path moves.
 */
export const resolveCalendarBlockMetrics = (
  days?: number,
  mobile = false,
): CalendarBlockMetrics => {
  const dayCount = days !== undefined && days > 0 ? days : undefined;
  const steps = mobile ? MOBILE_BLOCK_STEPS : DESKTOP_BLOCK_STEPS;
  const step = dayCount === undefined ? undefined : steps.find((item) => dayCount <= item.maxDays);
  const { blockMargin, blockRadius, blockSize } =
    step ?? (mobile ? MOBILE_YEAR_BLOCK : DESKTOP_YEAR_BLOCK);

  return {
    blockMargin,
    blockRadius,
    blockSize,
    hideMonthLabels: dayCount !== undefined && dayCount < MONTH_LABEL_MIN_DAYS,
  };
};

/** The `YYYY-MM-DD` day a bucket belongs to. */
export const activityBucketDay = (bucket: string): string => bucket.slice(0, 10);

/**
 * Calendar days a settled series covers, counted from the buckets themselves.
 *
 * The series is zero-filled per bucket on the display zone's calendar, so its distinct
 * days *are* the grid's columns. Dividing the window span by 24h would instead count
 * elapsed periods: a fortnight straddling a fall-back switch lasts 337 hours and would
 * round up to 15 days, dropping the blocks a size and reserving an empty month-label
 * row. `undefined` for an empty or missing series — there is nothing to scale to.
 */
export const activitySeriesDays = (rows?: Array<{ bucket: string }>): number | undefined => {
  if (!rows?.length) return undefined;

  const days = new Set<string>();
  for (const row of rows) days.add(activityBucketDay(row.bucket));
  return days.size;
};

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

/** Hours in a day — the width of one hour-strip row. */
export const HOURS_PER_DAY = 24;

export interface ActivityHourCell {
  count: number;
  /** `HH:00`, prefixed with `M/D` when the window straddles midnight. */
  label: string;
  level: number;
}

export interface ActivityHourRow {
  /** The `YYYY-MM-DD` this row draws — stable enough to key it by. */
  day: string;
  /** `M/D` for the row, only set when the window covers more than one day. */
  dayLabel?: string;
  /** 24 slots; `undefined` where the window does not cover that hour. */
  hours: Array<ActivityHourCell | undefined>;
}

/** The `0`–`23` slot a bucket occupies, or `undefined` when it is not an hour bucket. */
const activityBucketHour = (bucket: string): number | undefined => {
  const raw = bucket.slice(11, 13);
  if (raw.length !== 2) return undefined;

  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) return undefined;
  return hour;
};

/**
 * Lay an hourly series out as one 24-slot row per calendar day.
 *
 * The row is always the full day even when the window is not — "today" ends at the
 * current hour — so the blocks stay under the hour axis printed beneath them instead
 * of sliding left as the day fills up.
 */
export const toActivityHourRows = (rows?: StatsActivityBucket[]): ActivityHourRow[] => {
  if (!rows?.length) return [];

  const withDate = activitySpansDays(rows);
  const byDay = new Map<string, ActivityHourRow>();

  for (const row of rows) {
    const hour = activityBucketHour(row.bucket);
    if (hour === undefined) continue;

    const day = activityBucketDay(row.bucket);
    let entry = byDay.get(day);
    if (!entry) {
      entry = {
        day,
        dayLabel: withDate ? formatActivityBucketLabel(day, 'calendar') : undefined,
        hours: Array.from({ length: HOURS_PER_DAY }),
      };
      byDay.set(day, entry);
    }
    entry.hours[hour] = {
      count: row.count,
      label: formatActivityBucketLabel(row.bucket, 'hour', withDate),
      level: row.level,
    };
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
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
