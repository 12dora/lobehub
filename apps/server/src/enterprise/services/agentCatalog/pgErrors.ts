import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';

/** PG `severity` values used to duck-type a raw driver error from unrelated `code` holders. */
const PG_SEVERITIES = new Set(['ERROR', 'FATAL', 'PANIC']);
const MAX_CAUSE_DEPTH = 5;

interface PgErrorInfo {
  code: string;
  constraint?: string;
  message: string;
}

/**
 * Walk the `.cause` chain (drizzle wraps, transaction runners double-wrap) for a raw
 * PostgreSQL driver error and return its SQLSTATE, constraint name, and message. Returns
 * null when no PG layer is found, so non-database failures pass through unchanged.
 */
const unwrapPgError = (error: unknown): PgErrorInfo | null => {
  let current = error as
    { cause?: unknown; code?: unknown; constraint?: unknown; message?: unknown } | undefined;
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
      return {
        code: current.code,
        constraint,
        message: typeof current.message === 'string' ? current.message : '',
      };
    }
    current = current.cause as typeof current;
  }
  return null;
};

/** Non-system-key unique indexes whose violation is a user-visible naming/target conflict. */
const INVALID_INPUT_UNIQUE_CONSTRAINTS = new Set([
  'platform_agents_agent_key_unique',
  'platform_agent_versions_agent_id_version_unique',
  'platform_agent_versions_agent_id_id_unique',
  'platform_agent_versions_agent_id_id_checksum_unique',
  'platform_agent_assignments_agent_target_unique',
]);

/**
 * Foreign keys whose violation reflects an invalid reference in the request.
 *
 * These are the exact names PostgreSQL reports — identifiers longer than 63 bytes are
 * truncated by the server (NAMEDATALEN-1), so the two long materialization FKs appear here
 * in their real, truncated form (verified against pg_constraint), not the Drizzle spelling.
 */
const INVALID_INPUT_FK_CONSTRAINTS = new Set([
  'platform_agent_assignments_pinned_version_same_agent_fk',
  'platform_agent_assignments_agent_id_platform_agents_id_fk',
  'platform_agents_current_version_same_agent_fk',
  'platform_user_agent_materializations_exact_version_fk',
  // Truncated at 63 bytes: ..._platform_agent_id_platform_agents_id_fk / ..._materialized_agent_id_agents_id_fk
  'platform_user_agent_materializations_platform_agent_id_platform',
  'platform_user_agent_materializations_materialized_agent_id_agen',
]);

/**
 * Fixed marker text of the platform Agent trigger `RAISE EXCEPTION`s that a reference write
 * can hit. Trigger errors carry no constraint name, so they are matched by their stable
 * (non-localized) message. Kept in sync with migration 0125.
 */
const INVALID_INPUT_TRIGGER_MARKERS = [
  'platform Agent assignments require an existing', // enforce_platform_agent_assignment_target
  'materialized Agent must belong to', // enforce_platform_user_agent_materialization_owner
];

/**
 * Normalize raw PostgreSQL constraint / trigger failures raised by platform Agent writes
 * into stable, redacted service errors (ADM-03). The public boundary must never expose
 * SQLSTATE, constraint names, table/column names, or the offending value (which for unique
 * violations includes the agent key / target user / role).
 *
 * Mapping is driven by the *actual* constraint name or trigger marker — never a blanket
 * SQLSTATE bucket — so an unexpected 23503/23505 from anywhere else surfaces untouched
 * instead of being mislabeled as invalid input:
 * - `platform_agents_system_key_unique` (23505) → RevisionConflict (default-inbox singleton race).
 * - a known unique index (23505) → InvalidInput (agent key / SemVer / assignment target already exists).
 * - a known platform-Agent foreign key (23503) → InvalidInput (invalid reference in the request).
 * - a recognized platform-Agent trigger message (23503) → InvalidInput (missing user / role / owner).
 * - anything else → the original error, unchanged.
 */
export const translatePlatformAgentPgError = (error: unknown): unknown => {
  const pg = unwrapPgError(error);
  if (!pg) return error;

  if (pg.code === '23505') {
    if (pg.constraint === 'platform_agents_system_key_unique') {
      return new PlatformAgentRevisionConflictError();
    }
    if (pg.constraint && INVALID_INPUT_UNIQUE_CONSTRAINTS.has(pg.constraint)) {
      return new PlatformAgentInvalidInputError();
    }
    return error;
  }

  if (pg.code === '23503') {
    if (pg.constraint && INVALID_INPUT_FK_CONSTRAINTS.has(pg.constraint)) {
      return new PlatformAgentInvalidInputError();
    }
    if (INVALID_INPUT_TRIGGER_MARKERS.some((marker) => pg.message.includes(marker))) {
      return new PlatformAgentInvalidInputError();
    }
    return error;
  }

  return error;
};
