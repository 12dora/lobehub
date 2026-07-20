// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PlatformSecretRewrapConflictError } from './errors';
import {
  getPlatformSecretRewrapPgErrorIdentity,
  PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT,
  translatePlatformSecretRewrapPgError,
} from './pgErrors';

const pgError = (code: string, constraint: string, constraintName = false) =>
  constraintName ? { code, constraint_name: constraint } : { code, constraint };

describe('secret rewrap PostgreSQL error classification', () => {
  it('finds driver identity through nested Drizzle causes and constraint_name aliases', () => {
    const nested = {
      cause: {
        cause: pgError('23505', PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT, true),
        code: 'DRIZZLE_WRAPPER',
      },
    };
    expect(getPlatformSecretRewrapPgErrorIdentity(nested)).toEqual({
      code: '23505',
      constraint: PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT,
    });
    expect(translatePlatformSecretRewrapPgError(nested)).toBeInstanceOf(
      PlatformSecretRewrapConflictError,
    );
  });

  it('does not translate another unique constraint, another code, or an untyped message', () => {
    const cyclic = { cause: undefined as unknown };
    cyclic.cause = cyclic;
    for (const error of [
      pgError('23505', 'platform_jobs_type_idempotency_key_unique'),
      pgError('23503', PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT),
      new Error(`23505 ${PLATFORM_SECRET_REWRAP_SINGLE_ACTIVE_CONSTRAINT}`),
      { cause: pgError('40001', 'future_platform_jobs_constraint') },
      cyclic,
    ]) {
      expect(translatePlatformSecretRewrapPgError(error)).toBe(error);
    }
  });
});
