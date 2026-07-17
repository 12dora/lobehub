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
