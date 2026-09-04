export class PlatformAgentNotFoundError extends Error {
  readonly code = 'PLATFORM_NOT_FOUND';

  constructor() {
    super('PLATFORM_NOT_FOUND');
  }
}

export class PlatformAgentRevisionConflictError extends Error {
  readonly code = 'PLATFORM_REVISION_CONFLICT';

  constructor() {
    super('PLATFORM_REVISION_CONFLICT');
  }
}

export class PlatformAgentDefaultRequiredError extends Error {
  readonly code = 'PLATFORM_DEFAULT_AGENT_REQUIRED';

  constructor(message = 'PLATFORM_DEFAULT_AGENT_REQUIRED') {
    super(message);
  }
}

/**
 * Stable, detail-free rejection for invalid mutations — e.g. attempting to set or
 * change the managed default-inbox flag outside `setDefaultInbox`, or a normalized
 * unique/foreign-key constraint conflict (agent key, SemVer, assignment target).
 * Never carries the offending value, constraint name, or target identifier.
 */
export class PlatformAgentInvalidInputError extends Error {
  readonly code = 'PLATFORM_INVALID_INPUT';

  constructor(message = 'PLATFORM_INVALID_INPUT') {
    super(message);
  }
}

/**
 * Stable rejection when a destructive mutation (archive) is blocked by existing
 * Assignment / Materialization references. No reference identifiers cross the boundary.
 */
export class PlatformAgentResourceInUseError extends Error {
  readonly code = 'PLATFORM_RESOURCE_IN_USE';

  constructor() {
    super('PLATFORM_RESOURCE_IN_USE');
  }
}

/**
 * Stable, detail-free failure of the delayed-materialization path (M10 PR-049). Raised when the
 * pinned exact version/checksum cannot be honored (missing version, checksum mismatch, malformed
 * dependency refs) or the local Agent could not be attached. Fail-closed: never carries SQL,
 * constraint names, the local Agent id, or any secret material.
 */
export class PlatformAgentMaterializationError extends Error {
  readonly code = 'PLATFORM_MATERIALIZATION_FAILED';

  constructor() {
    super('PLATFORM_MATERIALIZATION_FAILED');
  }
}

/**
 * Stable, detail-free fallback for any UNKNOWN failure at a platform Agent read boundary
 * (resolver / effective list / exact version lookup). Raised in place of a raw driver / SQL error
 * so the public boundary can never leak SQLSTATE, constraint names, table/column names, the
 * offending value, or a user / role / target / provider identifier (REWORK-5).
 */
export class PlatformAgentUnavailableError extends Error {
  readonly code = 'PLATFORM_UNAVAILABLE';

  constructor() {
    super('PLATFORM_UNAVAILABLE');
  }
}

/** The stable, already-redacted platform Agent errors that are safe to surface verbatim. */
const REDACTED_PLATFORM_ERRORS = [
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
  PlatformAgentDefaultRequiredError,
  PlatformAgentInvalidInputError,
  PlatformAgentResourceInUseError,
  PlatformAgentMaterializationError,
  PlatformAgentUnavailableError,
] as const;

/**
 * Redact an unexpected error thrown behind a platform Agent read boundary. A known, already-stable
 * platform error (and the dependency-validation error, which only carries issue codes) passes
 * through so NOT_FOUND / materialization / validation classifications are preserved; anything else
 * — a raw postgres driver error, an unexpected throw — collapses to a detail-free
 * `PlatformAgentUnavailableError`. Never returns the original message.
 */
export const redactPlatformReadError = (error: unknown): Error => {
  if (REDACTED_PLATFORM_ERRORS.some((ctor) => error instanceof ctor)) return error as Error;
  if (error instanceof PlatformAgentDependencyValidationError) return error;
  return new PlatformAgentUnavailableError();
};

export type PlatformAgentDependencyIssueCode =
  | 'AI_MODEL_UNAVAILABLE'
  | 'CONNECTOR_UNAVAILABLE'
  | 'CONNECTOR_TOOL_UNAVAILABLE'
  | 'SKILL_UNAVAILABLE';

/** Stable, detail-free error. Dependency identifiers never cross the public boundary. */
export class PlatformAgentDependencyValidationError extends Error {
  readonly code = 'PLATFORM_CONFIG_VALIDATION_FAILED';
  readonly issueCodes: PlatformAgentDependencyIssueCode[];

  constructor(issueCodes: PlatformAgentDependencyIssueCode[]) {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
    this.issueCodes = [...new Set(issueCodes)].sort();
  }
}
