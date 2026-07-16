export interface AiCatalogDependent {
  blocking: boolean;
  label: string;
  resourceId: string;
  resourceType: string;
}

export class AiCatalogNotFoundError extends Error {}

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
