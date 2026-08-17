import { PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES } from '../../schemas/platform';
import { PlatformRevisionConflictError } from './errors';

export class PlatformGlobalCredentialConflictError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_CONFLICT';
  constructor(message = 'Credential key already exists') {
    super(message);
    this.name = 'PlatformGlobalCredentialConflictError';
  }
}

export { PlatformRevisionConflictError };

export class PlatformGlobalCredentialNotFoundError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_NOT_FOUND';
  constructor(message = 'Credential not found') {
    super(message);
    this.name = 'PlatformGlobalCredentialNotFoundError';
  }
}

export class PlatformGlobalCredentialFileTooLargeError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_FILE_TOO_LARGE';
  readonly maxBytes = PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES;
  constructor(message = `File exceeds ${PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES} byte limit`) {
    super(message);
    this.name = 'PlatformGlobalCredentialFileTooLargeError';
  }
}

export class PlatformGlobalCredentialValidationError extends Error {
  readonly code = 'PLATFORM_GLOBAL_CREDENTIAL_VALIDATION';
  constructor(
    message: string,
    readonly validationCode?: string,
  ) {
    super(message);
    this.name = 'PlatformGlobalCredentialValidationError';
  }
}
