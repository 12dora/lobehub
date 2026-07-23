/**
 * Bound list / facet / stats windows by policy maxListWindowDays.
 * Prevents full-table scans from unbounded admin queries.
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ResolvedAuditTimeWindow {
  from: Date;
  to: Date;
}

/**
 * Resolve inclusive `from` / exclusive `to` within maxListWindowDays.
 * Defaults: `to = now`, `from = to - maxListWindowDays`.
 */
export const resolveAuditTimeWindow = (params: {
  from?: Date;
  maxListWindowDays: number;
  to?: Date;
}): ResolvedAuditTimeWindow => {
  const maxDays = Math.max(1, Math.min(Math.floor(params.maxListWindowDays), 365));
  const maxMs = maxDays * MS_PER_DAY;
  const now = new Date();

  const to = params.to ?? now;
  const from = params.from ?? new Date(to.getTime() - maxMs);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'invalid_time_window' },
      httpCode: 'BAD_REQUEST',
      message: 'Invalid audit time window',
    });
  }

  if (from.getTime() >= to.getTime()) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'from_not_before_to' },
      httpCode: 'BAD_REQUEST',
      message: 'Audit time window requires from < to',
    });
  }

  if (to.getTime() - from.getTime() > maxMs) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { maxListWindowDays: maxDays, reason: 'window_exceeds_max_list_window_days' },
      httpCode: 'BAD_REQUEST',
      message: `Audit time window must not exceed ${maxDays} days`,
    });
  }

  return { from, to };
};
