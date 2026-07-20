import { PlatformSecretRewrapConflictError } from './errors';

export const PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT =
  'platform_jobs_secret_rewrap_single_active_unique';

const MAX_CAUSE_DEPTH = 5;

interface PgErrorIdentity {
  code: string;
  constraint?: string;
}

/** Read only PostgreSQL identity fields through Drizzle/driver cause wrappers. */
export const getPlatformSecretRewrapPgErrorIdentity = (error: unknown): PgErrorIdentity | null => {
  let fallback: PgErrorIdentity | null = null;
  const visited = new Set<object>();
  let current = error as
    | { cause?: unknown; code?: unknown; constraint?: unknown; constraint_name?: unknown }
    | undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    if (typeof current.code === 'string') {
      const constraint =
        typeof current.constraint === 'string'
          ? current.constraint
          : typeof current.constraint_name === 'string'
            ? current.constraint_name
            : undefined;
      const identity = { code: current.code, constraint };
      if (constraint) return identity;
      fallback ??= identity;
    }
    current = current.cause as typeof current;
  }
  return fallback;
};

/** Translate only the database-enforced single-active invariant; preserve every other failure. */
export const translatePlatformSecretRewrapPgError = (error: unknown): unknown => {
  const pg = getPlatformSecretRewrapPgErrorIdentity(error);
  if (pg?.code === '23505' && pg.constraint === PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT) {
    return new PlatformSecretRewrapConflictError();
  }
  return error;
};
