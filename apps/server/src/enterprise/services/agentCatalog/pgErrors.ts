import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';

/** PG `severity` values used to duck-type a raw driver error from unrelated `code` holders. */
const PG_SEVERITIES = new Set(['ERROR', 'FATAL', 'PANIC']);
const MAX_CAUSE_DEPTH = 5;

interface PgErrorInfo {
  code: string;
  constraint?: string;
}

/**
 * Walk the `.cause` chain (drizzle wraps, transaction runners double-wrap) for a raw
 * PostgreSQL driver error and return its SQLSTATE + constraint name. Returns null when
 * no PG layer is found, so non-database failures pass through unchanged.
 */
const unwrapPgError = (error: unknown): PgErrorInfo | null => {
  let current = error as { cause?: unknown; code?: unknown; constraint?: unknown } | undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    const severity = (current as { severity?: unknown }).severity;
    if (
      typeof current.code === 'string' &&
      typeof severity === 'string' &&
      PG_SEVERITIES.has(severity)
    ) {
      const constraint =
        (current.constraint as string | undefined) ??
        (current as { constraint_name?: string }).constraint_name;
      return { code: current.code, constraint };
    }
    current = current.cause as typeof current;
  }
  return null;
};

/**
 * Normalize raw PostgreSQL constraint / trigger failures raised by platform Agent
 * writes into stable, redacted service errors (ADM-03). The public boundary must
 * never expose SQLSTATE, constraint names, table/column names, or the offending
 * value (which for unique violations includes the agent key / target user / role).
 *
 * Contract mapping (by constraint, then SQLSTATE):
 * - `platform_agents_system_key_unique` (23505) → RevisionConflict.
 *   Concurrent default-inbox singleton race — the loser retries against fresh state.
 * - any other unique violation (23505) — agent key, SemVer version, assignment
 *   target — → InvalidInput. A stable "already exists" style conflict.
 * - foreign-key / target-guard trigger violation (23503) — missing user / global
 *   role, cross-agent pinned version — → InvalidInput.
 *
 * Returns the mapped error to throw, or the original error untouched when it is not
 * a recognized PostgreSQL driver error (so genuine bugs still surface).
 */
export const translatePlatformAgentPgError = (error: unknown): unknown => {
  const pg = unwrapPgError(error);
  if (!pg) return error;

  if (pg.code === '23505') {
    return pg.constraint === 'platform_agents_system_key_unique'
      ? new PlatformAgentRevisionConflictError()
      : new PlatformAgentInvalidInputError();
  }

  if (pg.code === '23503') {
    return new PlatformAgentInvalidInputError();
  }

  return error;
};
