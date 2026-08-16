import type { FilterValue } from 'antd/es/table/interface';

import { getDefaultAuditTimeWindow } from '../shared/timeWindow';

export const RESULT_VALUES = ['success', 'failure', 'denied'] as const;
export type AuditResult = (typeof RESULT_VALUES)[number];

export interface ListFilters {
  actions: string[];
  actorUserId?: string;
  from: Date;
  requestId?: string;
  results: AuditResult[];
  targetId?: string;
  targetType?: string;
  to: Date;
}

export const emptyFilters = (): ListFilters => {
  const window = getDefaultAuditTimeWindow();
  return {
    actions: [],
    from: window.from,
    results: [],
    to: window.to,
  };
};

export const toStringList = (value: FilterValue | null | undefined): string[] => {
  if (!value) return [];
  return value.map(String).filter((item) => item !== '');
};

export const firstNonEmpty = (value: FilterValue | null | undefined): string | undefined => {
  const [first] = toStringList(value);
  return first;
};

export const toResultList = (value: FilterValue | null | undefined): AuditResult[] =>
  toStringList(value).filter((item): item is AuditResult =>
    RESULT_VALUES.includes(item as AuditResult),
  );

export const sameStringList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

export const listFiltersEqual = (left: ListFilters, right: ListFilters): boolean =>
  sameStringList(left.actions, right.actions) &&
  sameStringList(left.results, right.results) &&
  left.actorUserId === right.actorUserId &&
  left.requestId === right.requestId &&
  left.targetId === right.targetId &&
  left.targetType === right.targetType &&
  left.from.getTime() === right.from.getTime() &&
  left.to.getTime() === right.to.getTime();
