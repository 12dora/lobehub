import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

/**
 * Typed error for Platform Secret Service.
 * `code` maps to PLATFORM_* so tRPC/HTTP layers can surface stable codes.
 */
export class PlatformSecretError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlatformSecretError';
    this.code = code;
  }
}

export const secretMasterKeyMissing = (message?: string) =>
  new PlatformSecretError(
    PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    message ??
      `Platform master key is required when enterprise features are enabled. ` +
        `Set PLATFORM_MASTER_KEY to a base64-encoded 32-byte key ` +
        `(e.g. \`openssl rand -base64 32\`).`,
  );

export const secretNotReadable = (message?: string, details?: Record<string, unknown>) =>
  new PlatformSecretError(
    PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
    message ?? 'Ciphertext could not be decrypted (wrong key, tampered data, or corrupt envelope).',
    details,
  );

export const secretInvalidInput = (message: string, details?: Record<string, unknown>) =>
  new PlatformSecretError(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, message, details);
