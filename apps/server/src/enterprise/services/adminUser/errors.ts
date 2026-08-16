/**
 * Admin user management errors and pure helpers (M04).
 */
import { createHash, randomBytes } from 'node:crypto';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

export class AdminUserNotFoundError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

  constructor(message = PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) {
    super(message);
    this.name = 'AdminUserNotFoundError';
  }
}

export class AdminUserSelfBanError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;

  constructor(message = 'Cannot ban yourself') {
    super(message);
    this.name = 'AdminUserSelfBanError';
  }
}

export class AdminUserSelfDeleteError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;

  constructor(message = 'Cannot delete yourself') {
    super(message);
    this.name = 'AdminUserSelfDeleteError';
  }
}

export class AdminUserSelfRoleChangeError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;

  constructor(message = 'Cannot change your own roles') {
    super(message);
    this.name = 'AdminUserSelfRoleChangeError';
  }
}

/**
 * Duplicate email (or username) on admin credential-user create.
 * Maps to public PLATFORM_INVALID_INPUT with a machine-readable reason.
 */
export class AdminUserEmailConflictError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode: 'email_taken' | 'username_taken';

  constructor(reasonCode: 'email_taken' | 'username_taken' = 'email_taken') {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'AdminUserEmailConflictError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Email/password auth is disabled instance-wide (AUTH_DISABLE_EMAIL_PASSWORD),
 * so an admin-provisioned credential user could never sign in. Rejected before
 * any write. Maps to public PLATFORM_INVALID_INPUT with a machine-readable reason.
 */
export class AdminUserPasswordAuthDisabledError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode = 'password_auth_disabled' as const;

  constructor() {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'AdminUserPasswordAuthDisabledError';
  }
}

/**
 * Invalid retained-session candidate on revokeSessions (missing / expired / foreign).
 * Maps to public PLATFORM_INVALID_INPUT without leaking whether a foreign session exists.
 */
export class InvalidRetainedSessionError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode:
    'retained_session_missing' | 'retained_session_expired' | 'retained_session_invalid';

  constructor(
    reasonCode:
      | 'retained_session_missing'
      | 'retained_session_expired'
      | 'retained_session_invalid' = 'retained_session_invalid',
  ) {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'InvalidRetainedSessionError';
    this.reasonCode = reasonCode;
  }
}

/** One-way fingerprint of search text — never store full query. */
export const fingerprintQuery = (query: string | undefined): string | null => {
  if (!query) return null;
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
};

export const generateEntityId = (prefix: string): string => prefix + randomBytes(6).toString('hex');

/**
 * Walk the error cause chain for a Postgres unique violation (23505).
 * Returns the constraint hint (constraint name or message) — never row values.
 */
export const findUniqueViolation = (error: unknown): { constraint: string } | null => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
    if (candidate.code === '23505') {
      return {
        constraint:
          typeof candidate.constraint === 'string'
            ? candidate.constraint
            : String(candidate.message ?? ''),
      };
    }
    current = candidate.cause;
  }
  return null;
};
