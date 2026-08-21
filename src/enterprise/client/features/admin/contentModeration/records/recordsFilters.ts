import type { FilterValue } from 'antd/es/table/interface';
import dayjs from 'dayjs';

import type {
  ModerationCategory,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';

import { DEFAULT_PAGE_SIZE } from '../../primitives/dataTableChange';

export const DEFAULT_RECORDS_PAGE_SIZE = DEFAULT_PAGE_SIZE;

export interface RecordsFilters {
  actions: ModerationEffectiveAction[];
  categories: ModerationCategory[];
  from?: Date;
  /** 显示放行记录 — only meaningful when the settings record non-hits at all. */
  includeNonHits: boolean;
  requestKinds: ModerationRequestKind[];
  search?: string;
  sources: ModerationDecisionSource[];
  to?: Date;
  userQuery?: string;
}

export const emptyRecordsFilters = (): RecordsFilters => ({
  actions: [],
  categories: [],
  includeNonHits: false,
  requestKinds: [],
  sources: [],
});

export const toStringList = (value: FilterValue | null | undefined): string[] =>
  value ? value.map(String).filter(Boolean) : [];

export const firstNonEmpty = (value: FilterValue | null | undefined): string | undefined =>
  toStringList(value)[0];

export const pickFrom = <T extends string>(
  allowed: readonly T[],
  value: FilterValue | null | undefined,
): T[] =>
  toStringList(value).filter((item): item is T => (allowed as readonly string[]).includes(item));

/**
 * The day RangePicker hands back local midnight for BOTH ends, and the server filters with
 * `createdAt < to`. Passing the picked end day straight through therefore drops that whole day.
 * Normalize to a half-open `[startOfFromDay, startOfDayAfterToDay)` window instead.
 */
export const toRangeStart = (value: Date | null | undefined): Date | undefined =>
  value ? dayjs(value).startOf('day').toDate() : undefined;

export const toRangeEndExclusive = (value: Date | null | undefined): Date | undefined =>
  value ? dayjs(value).startOf('day').add(1, 'day').toDate() : undefined;

export const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

export const sameTime = (left?: Date, right?: Date): boolean =>
  (left?.getTime() ?? null) === (right?.getTime() ?? null);

/**
 * `DataTable.onChange` also fires for pagination, so the filter handler must be able to tell
 * "nothing changed" — otherwise paging to 2 would immediately reset back to page 1.
 */
export const recordsFiltersEqual = (left: RecordsFilters, right: RecordsFilters): boolean =>
  sameList(left.actions, right.actions) &&
  sameList(left.categories, right.categories) &&
  sameList(left.requestKinds, right.requestKinds) &&
  sameList(left.sources, right.sources) &&
  left.includeNonHits === right.includeNonHits &&
  left.search === right.search &&
  left.userQuery === right.userQuery &&
  sameTime(left.from, right.from) &&
  sameTime(left.to, right.to);

/**
 * Turn UI state into the `listRecords` input. Kept pure so a test can assert the mapping
 * without rendering a table.
 */
export const buildRecordsListInput = (
  filters: RecordsFilters,
  page: number,
  pageSize: number,
  userId?: string,
) => ({
  actions: filters.actions.length ? filters.actions : undefined,
  categories: filters.categories.length ? filters.categories : undefined,
  from: filters.from,
  includeNonHits: filters.includeNonHits || undefined,
  limit: pageSize,
  offset: (page - 1) * pageSize,
  requestKinds: filters.requestKinds.length ? filters.requestKinds : undefined,
  search: filters.search || undefined,
  sources: filters.sources.length ? filters.sources : undefined,
  to: filters.to,
  userId: userId || undefined,
  userQuery: filters.userQuery || undefined,
});
