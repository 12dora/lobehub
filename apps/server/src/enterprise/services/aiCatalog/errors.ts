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

/**
 * A pinned platform provider revision can no longer be resolved: the provider was hard-deleted
 * (its revision history purged with it) while an operation that pinned that exact revision was
 * still in flight, or the pinned checksum no longer matches.
 *
 * Terminal by design — MODEL-EXACT never falls back to the current pointer or to user BYOK.
 * Carries `errorType` so the chat error formatter classifies it as a real, labelled provider
 * error instead of wrapping it as an opaque internal server error.
 */
export class AiCatalogProviderUnavailableError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED;
  readonly errorType = PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED;

  constructor(providerKey?: string) {
    super(PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED);
    this.name = 'AiCatalogProviderUnavailableError';
    if (providerKey) {
      Object.defineProperty(this, 'providerKey', { enumerable: false, value: providerKey });
    }
  }
}

/**
 * The caller lacks a platform permission that only the executing transaction could
 * establish the need for — e.g. a `batchUpdate` item that turns out to be an INSERT and
 * therefore requires AI_MODEL_CREATE, which the router's input-only compound gate cannot
 * classify. Routers map this to a FORBIDDEN permission denial.
 */
export class AiCatalogPermissionDeniedError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED;
  readonly permission: string;

  constructor(permission: string) {
    super(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
    this.name = 'AiCatalogPermissionDeniedError';
    this.permission = permission;
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

/**
 * The runtime has no `models()` enumerator — distinct from an empty upstream list so
 * the admin client can render "this provider cannot enumerate its models".
 */
export class AiCatalogCannotEnumerateError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reason = 'cannot_enumerate' as const;

  constructor() {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'AiCatalogCannotEnumerateError';
  }
}

/**
 * A live upstream `models()` (or the shared-grant refresh that precedes it) failed with
 * a classified runtime fault — transport missing, OAuth expired, incomplete credential
 * already became {@link AiCatalogValidationError}. The router maps this to the same
 * stable codes the connection probe uses, not a generic 500.
 */
export class AiCatalogUpstreamSyncError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED;
  readonly errorCategory: string;
  readonly errorType?: string;

  constructor(params: { errorCategory: string; errorType?: string; message: string }) {
    super(params.message);
    this.name = 'AiCatalogUpstreamSyncError';
    this.errorCategory = params.errorCategory;
    this.errorType = params.errorType;
  }
}
