import {
  PlatformRevisionConflictError,
  PlatformRevisionImmutableError,
} from '@/database/models/platform';

const PG_ERROR_SEVERITIES = new Set(['ERROR', 'FATAL', 'PANIC']);
const PG_OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';
const MAX_PG_CAUSE_DEPTH = 5;

/**
 * Revisions are append-only (migration 0145). Any attempt to UPDATE/DELETE a
 * revision row, or a CAS race that surfaces as a PG immutability error, is a
 * revision conflict at the service boundary — never leak raw driver errors.
 */
export const mapRevisionBoundaryError = (error: unknown): unknown => {
  if (error instanceof PlatformRevisionConflictError) return error;
  if (error instanceof PlatformRevisionImmutableError) {
    return new PlatformRevisionConflictError();
  }

  let current: unknown = error;
  for (let depth = 0; depth < MAX_PG_CAUSE_DEPTH && current; depth += 1) {
    if (current instanceof PlatformRevisionConflictError) return current;
    if (current instanceof PlatformRevisionImmutableError) {
      return new PlatformRevisionConflictError();
    }

    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      severity?: unknown;
    };
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const code = typeof candidate.code === 'string' ? candidate.code : undefined;
    const severity = typeof candidate.severity === 'string' ? candidate.severity : undefined;
    const isPg =
      typeof severity === 'string' && PG_ERROR_SEVERITIES.has(severity) && typeof code === 'string';
    if (
      (isPg && code === PG_OBJECT_NOT_IN_PREREQUISITE_STATE) ||
      /platform_resource_revisions are immutable/i.test(message)
    ) {
      return new PlatformRevisionConflictError();
    }
    current = candidate.cause;
  }

  return error;
};
