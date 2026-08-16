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
}

/** Week columns the trailing calendar always draws — the year view's own shape. */
export const CALENDAR_WEEKS = 52;

/** The year view's block metrics; also the ceiling the fluid grid grows to. */
const DESKTOP_CALENDAR_BLOCK = { blockMargin: 4, blockRadius: 2, blockSize: 14 };
const MOBILE_CALENDAR_BLOCK = { blockMargin: 3, blockRadius: 2, blockSize: 6 };
/** Below this the gap gives way first, then the block; nothing smaller stays legible. */
const TIGHT_BLOCK_MARGIN = 2;
const MIN_BLOCK_SIZE = 4;

/**
 * Fit the 52-week calendar to the width it has been given: blocks shrink from the
 * year-view size until every column fits, then the gap tightens, down to a floor that
 * still reads as squares. Without a measured width (first paint, tests) it is exactly
 * the year-view metrics.
 */
export const resolveCalendarBlockMetrics = (
  width?: number,
  mobile = false,
): CalendarBlockMetrics => {
  const base = mobile ? MOBILE_CALENDAR_BLOCK : DESKTOP_CALENDAR_BLOCK;
  if (!width || width <= 0) return base;
  const columns = CALENDAR_WEEKS + 1;
  const fit = (margin: number) => Math.floor((width - (columns - 1) * margin) / columns);

  const roomy = fit(base.blockMargin);
  if (roomy >= MOBILE_CALENDAR_BLOCK.blockSize) {
    return { ...base, blockSize: Math.min(base.blockSize, roomy) };
  }
  const tight = Math.max(MIN_BLOCK_SIZE, Math.min(base.blockSize, fit(TIGHT_BLOCK_MARGIN)));
  return { ...base, blockMargin: TIGHT_BLOCK_MARGIN, blockRadius: 1, blockSize: tight };
};

/** Half-open ISO window `[startAt, endAt)`. */
export interface ActivityWindow {
  endAt: string;
  startAt: string;
}

const DAY_MS = 24 * HOUR_MS;

/** Local midnight on/before `instant`. */
const startOfLocalDay = (instant: Date): Date => {
  const day = new Date(instant);
  day.setHours(0, 0, 0, 0);
  return day;
};

/** The server refuses windows wider than this; the calendar must stay inside it. */
const MAX_WINDOW_DAYS = 366;

/**
 * The calendar the ranged card draws: the {@link CALENDAR_WEEKS} weeks that end with
 * the selected window's last day, aligned to a Sunday column so the grid is full
 * columns edge to edge — the same shape as the unfiltered year view. The window's own
 * days are then highlighted on it (see {@link markActivityRange}); a short range is
 * a bright patch on a dense grid instead of a few marooned columns.
 *
 * A selected window that reaches back further than those weeks (a full-year custom
 * range) widens the request to its own start, clamped to what the server allows, so
 * every selected day is fetched — the chart pads the first week itself.
 *
 * Without an end the window closes at the start of tomorrow (local), so a filter that
 * only pins a user still draws the trailing year.
 */
export const resolveCalendarWindow = (endAt?: string, startAt?: string): ActivityWindow => {
  const parsedEnd = endAt ? new Date(endAt) : undefined;
  const end =
    parsedEnd && !Number.isNaN(parsedEnd.getTime())
      ? parsedEnd
      : new Date(startOfLocalDay(new Date()).getTime() + DAY_MS);
  // The last calendar day the half-open window touches.
  const lastDay = startOfLocalDay(new Date(end.getTime() - 1));
  const calendarStart = new Date(lastDay.getTime() - (CALENDAR_WEEKS - 1) * 7 * DAY_MS);
  calendarStart.setDate(calendarStart.getDate() - calendarStart.getDay());

  const selectedStart = startAt ? new Date(startAt) : undefined;
  const floor = new Date(end.getTime() - MAX_WINDOW_DAYS * DAY_MS);
  let start = startOfLocalDay(calendarStart);
  if (selectedStart && !Number.isNaN(selectedStart.getTime()) && selectedStart < start) {
    start = startOfLocalDay(selectedStart);
  }
  if (start < floor) start = floor;
  return { endAt: end.toISOString(), startAt: start.toISOString() };
};

/** Levels the calendar draws; the range highlight doubles the palette. */
export const CALENDAR_MAX_LEVEL = 4;
/** Out-of-range days carry their level shifted by this, onto the dimmed half of the palette. */
export const OUT_OF_RANGE_LEVEL_OFFSET = CALENDAR_MAX_LEVEL + 1;

const localDayKey = (instant: Date): string => {
  const y = instant.getFullYear();
  const m = String(instant.getMonth() + 1).padStart(2, '0');
  const d = String(instant.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** First and last local calendar day a half-open window touches, as `YYYY-MM-DD`. */
export const resolveRangeDays = (
  startAt?: string,
  endAt?: string,
): { firstDay: string; lastDay: string } | undefined => {
  const start = startAt ? new Date(startAt) : undefined;
  const end = endAt ? new Date(endAt) : undefined;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return undefined;
  }
  if (end.getTime() <= start.getTime()) return undefined;
  return {
    firstDay: localDayKey(startOfLocalDay(start)),
    lastDay: localDayKey(startOfLocalDay(new Date(end.getTime() - 1))),
  };
};

/** Is a `YYYY-MM-DD…` bucket inside the selected window's days? */
export const isBucketInRange = (
  bucket: string,
  range?: { firstDay: string; lastDay: string },
): boolean => {
  if (!range) return true;
  const day = bucket.slice(0, 10);
  return day >= range.firstDay && day <= range.lastDay;
};

/** Just the buckets that fall inside the selected window. */
export const rowsInRange = <T extends { bucket: string }>(
  rows: T[] | undefined,
  range?: { firstDay: string; lastDay: string },
): T[] => (rows ?? []).filter((row) => isBucketInRange(row.bucket, range));

/**
 * Map the calendar series onto the heatmap's `Activity` shape, shifting days outside
 * the selected window onto the dimmed half of the palette so the window reads as a
 * highlight on the trailing year.
 */
export const markActivityRange = (
  rows: StatsActivityBucket[] | undefined,
  range?: { firstDay: string; lastDay: string },
): HeatmapsProps['data'] =>
  (rows ?? []).map((row) => {
    const level = Math.min(row.level, CALENDAR_MAX_LEVEL);
    return {
      count: row.count,
      date: row.bucket.slice(0, 10),
      level: isBucketInRange(row.bucket, range) ? level : level + OUT_OF_RANGE_LEVEL_OFFSET,
    };
  });

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
