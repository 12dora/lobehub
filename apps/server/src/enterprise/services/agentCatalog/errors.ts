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

  constructor() {
    super('PLATFORM_DEFAULT_AGENT_REQUIRED');
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

  constructor() {
    super('PLATFORM_INVALID_INPUT');
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
