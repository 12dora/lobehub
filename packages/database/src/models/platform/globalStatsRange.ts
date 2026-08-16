/**
 * Half-open instant range resolution and activity-bucket helpers for platform stats.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { SQL } from 'drizzle-orm';
import { and, gte, lt } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

dayjs.extend(utc);

/**
 * Parse a calendar day (`YYYY-MM-DD`) as UTC midnight.
 * Explicit UTC policy so half-open bounds do not shift with the process timezone (DB-008).
 */
const utcDayStart = (ymd: string): Date | null => {
  // Accept only date-shaped input; reject timestamps so callers stay calendar-day based.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const d = new Date(ymd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const utcDayAfter = (ymd: string): Date | null => {
  const start = utcDayStart(ymd);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Longest window an explicit `[startAt, endAt)` filter may span (admin stats DoS bound). */
export const MAX_STATS_RANGE_DAYS = 366;
/** Window used when only one explicit bound is supplied (defensive; clients send both). */
const DEFAULT_EXPLICIT_RANGE_DAYS = 30;

/** Invalid / oversized explicit window — routers map this to HTTP 400. */
export class StatsRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsRangeError';
  }
}

/**
 * Unknown IANA time zone on an activity series request. Subclasses
 * {@link StatsRangeError} so the routers' single 400 mapping keeps covering it,
 * while still allowing a precise `stats_timezone_invalid` reason.
 */
export class StatsTimeZoneError extends StatsRangeError {
  constructor(message: string) {
    super(message);
    this.name = 'StatsTimeZoneError';
  }
}

/**
 * Filter accepted by every platform stats aggregate.
 * `startAt` / `endAt` are exact instants forming a half-open window `[startAt, endAt)`;
 * they win over `mo`. Legacy `YYYY-MM-DD` strings stay accepted as UTC calendar-day
 * bounds (`endAt` becomes the following midnight, i.e. the day stays inclusive).
 */
export interface StatsRangeParams {
  endAt?: Date | string;
  mo?: string;
  startAt?: Date | string;
}

export interface StatsFilterParams extends StatsRangeParams {
  /** Restrict the aggregate to a single platform user. */
  userId?: string;
}

/** Month-shaped call sites keep accepting the legacy bare `mo` string. */
export type StatsFilterArg = string | StatsFilterParams | undefined;

export interface ResolvedStatsRange {
  /** Exclusive upper bound. */
  endAt: Date;
  /** Inclusive lower bound. */
  startAt: Date;
}

export const toStatsFilterParams = (arg: StatsFilterArg): StatsFilterParams =>
  typeof arg === 'string' ? { mo: arg } : (arg ?? {});

/** Instant for a lower bound: calendar days resolve to UTC midnight. */
const toStartInstant = (value: Date | string): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  return utcDayStart(value);
};

/** Instant for an exclusive upper bound: a calendar day resolves to the next UTC midnight. */
const toEndInstantExclusive = (value: Date | string): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return utcDayAfter(value);
  return utcDayStart(value);
};

/**
 * Single seam that turns every accepted stats filter into a half-open instant window.
 * Explicit `startAt` / `endAt` win over `mo`; without either, the (current) month is used.
 */
export const resolveStatsRange = (arg?: StatsFilterArg): ResolvedStatsRange => {
  const params = toStatsFilterParams(arg);

  if (params.startAt !== undefined || params.endAt !== undefined) {
    const endAt = params.endAt === undefined ? new Date() : toEndInstantExclusive(params.endAt);
    if (!endAt) throw new StatsRangeError('Invalid endAt');

    const startAt =
      params.startAt === undefined
        ? new Date(endAt.getTime() - DEFAULT_EXPLICIT_RANGE_DAYS * DAY_MS)
        : toStartInstant(params.startAt);
    if (!startAt) throw new StatsRangeError('Invalid startAt');

    if (startAt.getTime() >= endAt.getTime())
      throw new StatsRangeError('startAt must be before endAt');
    if (endAt.getTime() - startAt.getTime() > MAX_STATS_RANGE_DAYS * DAY_MS)
      throw new StatsRangeError(`Range must not exceed ${MAX_STATS_RANGE_DAYS} days`);

    return { endAt, startAt };
  }

  const month =
    params.mo && dayjs.utc(params.mo, 'YYYY-MM', true).isValid()
      ? dayjs.utc(params.mo, 'YYYY-MM').startOf('month')
      : dayjs.utc().startOf('month');

  return { endAt: month.add(1, 'month').toDate(), startAt: month.toDate() };
};

/**
 * Half-open `[startAt, endAt)` predicate on a timestamp column (DB-008): the upper
 * bound is exclusive, so midnight of the following day never leaks into a range.
 */
export const genInstantRangeWhere = (range: ResolvedStatsRange, key: AnyPgColumn): SQL =>
  and(gte(key, range.startAt), lt(key, range.endAt))!;

/** UTC calendar days covered by a half-open window (upper bound exclusive). */
export const eachUtcDayKey = ({ endAt, startAt }: ResolvedStatsRange): string[] => {
  const first = dayjs.utc(startAt).startOf('day');
  const last = dayjs.utc(new Date(endAt.getTime() - 1)).startOf('day');
  const keys: string[] = [];
  for (let date = first; !date.isAfter(last, 'day'); date = date.add(1, 'day')) {
    keys.push(date.format('YYYY-MM-DD'));
  }
  return keys;
};

/** Bucket width of an activity series. Mirrors the `date_trunc` unit used in SQL. */
export type ActivityGranularity = 'day' | 'hour' | 'week';
/** What an activity bucket counts: every message, or the assistant-gated token sum. */
export type ActivityMetric = 'messages' | 'tokens';

export interface ActivitySeriesParams extends StatsFilterParams {
  granularity?: ActivityGranularity;
  metric?: ActivityMetric;
  /** IANA zone the buckets are expressed in. Defaults to UTC. */
  timeZone?: string;
}

export interface ActivityPoint {
  /** `YYYY-MM-DDTHH:00` for hour buckets, `YYYY-MM-DD` for day / week (Monday) buckets. */
  bucket: string;
  count: number;
  /** 0..4 heatmap intensity. */
  level: number;
}

/** Below this span an activity series buckets by hour (today / last 24 hours). */
const HOURLY_ACTIVITY_SPAN_MS = 48 * 60 * 60 * 1000;
/**
 * Hard ceiling on the buckets one activity series may return. Derived granularity can
 * never reach it (366 daily buckets at most); an explicit `granularity: 'hour'` over a
 * long window can, and is rejected rather than silently coarsened.
 */
const MAX_ACTIVITY_BUCKETS = 2000;

/**
 * Canonical IANA zones plus `UTC`, which `Intl.supportedValuesOf` omits even though it
 * is the default here and a valid PostgreSQL zone. Matching is case-sensitive so the
 * value handed to `AT TIME ZONE` is always a zone both PostgreSQL and `Intl` agree on.
 */
let supportedTimeZones: Set<string> | undefined;
export const resolveActivityTimeZone = (timeZone?: string): string => {
  if (!timeZone) return 'UTC';
  supportedTimeZones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (!supportedTimeZones.has(timeZone)) throw new StatsTimeZoneError('Unknown IANA time zone');
  return timeZone;
};

const zonedHourFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Wall-clock hour of `at` in `timeZone`, carried as a UTC dayjs so bucket arithmetic
 * stays on the local calendar (a DST jump never shifts a day key).
 */
const zonedHour = (at: Date, timeZone: string) => {
  let formatter = zonedHourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    });
    zonedHourFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) parts[part.type] = part.value;
  return dayjs.utc(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00.000Z`);
};

/** Truncate a wall-clock hour to the bucket start; weeks start on Monday (date_trunc parity). */
const truncateToBucket = (at: dayjs.Dayjs, granularity: 'day' | 'week') => {
  const day = at.startOf('day');
  return granularity === 'day' ? day : day.subtract((day.day() + 6) % 7, 'day');
};

const formatBucketKey = (at: dayjs.Dayjs, granularity: ActivityGranularity) =>
  at.format(granularity === 'hour' ? 'YYYY-MM-DD[T]HH:00' : 'YYYY-MM-DD');

const tooManyBuckets = () =>
  new StatsRangeError(
    `Range yields more than ${MAX_ACTIVITY_BUCKETS} buckets; use a coarser granularity`,
  );

/**
 * Hour buckets by walking real instants, not wall-clock arithmetic: only hours that
 * actually exist in `timeZone` are emitted, so a spring-forward gap never yields a phantom
 * bucket and the two passes of a fall-back hour collapse into the single label PostgreSQL
 * groups them under. Sampled twice per hour because a few zones shift by 30 minutes
 * (Australia/Lord_Howe), which leaves a half-existing hour a whole-hour walk would skip.
 */
const eachHourKey = ({ endAt, startAt }: ResolvedStatsRange, timeZone: string): string[] => {
  const keys = new Set<string>();
  const add = (at: Date) => {
    keys.add(formatBucketKey(zonedHour(at, timeZone), 'hour'));
    if (keys.size > MAX_ACTIVITY_BUCKETS) throw tooManyBuckets();
  };

  const end = endAt.getTime();
  // Start on the UTC hour at or before `startAt`: in zones offset by :30 / :45 that instant
  // still belongs to the bucket holding `startAt`, never to an earlier one.
  for (let at = Math.floor(startAt.getTime() / HOUR_MS) * HOUR_MS; at < end; at += HOUR_MS / 2)
    add(new Date(at));
  // The final bucket may open after the last sampled UTC hour (again the :30 / :45 zones).
  add(new Date(end - 1));

  return [...keys];
};

/**
 * Day / week buckets. Calendar arithmetic on the zone's wall clock is DST-safe by
 * construction — a 23 or 25 hour day is still exactly one calendar date — as long as both
 * endpoints are derived from real instants, which they are.
 */
const eachCalendarKey = (
  { endAt, startAt }: ResolvedStatsRange,
  granularity: 'day' | 'week',
  timeZone: string,
): string[] => {
  const first = truncateToBucket(zonedHour(startAt, timeZone), granularity);
  const last = truncateToBucket(zonedHour(new Date(endAt.getTime() - 1), timeZone), granularity);
  const keys: string[] = [];
  for (let cursor = first; !cursor.isAfter(last); cursor = cursor.add(1, granularity)) {
    keys.push(formatBucketKey(cursor, granularity));
    if (keys.length > MAX_ACTIVITY_BUCKETS) throw tooManyBuckets();
  }
  return keys;
};

/** Every bucket a half-open window touches, expressed in `timeZone` (upper bound exclusive). */
export const eachBucketKey = (
  range: ResolvedStatsRange,
  granularity: ActivityGranularity,
  timeZone: string,
): string[] =>
  granularity === 'hour'
    ? eachHourKey(range, timeZone)
    : eachCalendarKey(range, granularity, timeZone);

/**
 * Bucket width when the caller did not pin one — derived from the window span. Only `hour`
 * and `day` are ever derived: an explicit window may not span more than
 * {@link MAX_STATS_RANGE_DAYS} days, so a span wide enough to warrant weeks cannot reach
 * here. `week` stays reachable through an explicit `granularity: 'week'`.
 */
export const deriveGranularity = ({ endAt, startAt }: ResolvedStatsRange): ActivityGranularity =>
  endAt.getTime() - startAt.getTime() < HOURLY_ACTIVITY_SPAN_MS ? 'hour' : 'day';
