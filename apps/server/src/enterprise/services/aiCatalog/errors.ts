import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

export interface AiCatalogDependent {
  blocking: boolean;
  label: string;
  resourceId: string;
  resourceType: string;
}

export class AiCatalogNotFoundError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

  constructor() {
    super(PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND);
  }
}

export class AiCatalogModelNotPublishedError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED;
  readonly errorType = PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED;

  constructor(model: string, operation: string) {
    super(PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED);
    this.name = 'AiCatalogModelNotPublishedError';
    Object.defineProperties(this, {
      model: { enumerable: false, value: model },
      operation: { enumerable: false, value: operation },
    });
  }
}

export class AiCatalogValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
    this.issues = issues;
  }
}

export class AiCatalogResourceInUseError extends Error {
  readonly dependents: AiCatalogDependent[];

  constructor(dependents: AiCatalogDependent[]) {
    super('PLATFORM_RESOURCE_IN_USE');
    this.dependents = dependents;
  }
}
