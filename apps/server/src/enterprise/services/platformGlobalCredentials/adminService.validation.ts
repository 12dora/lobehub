import { PlatformGlobalCredentialValidationError } from '@/database/models/platform';

import { PLATFORM_GLOBAL_CREDENTIAL_MASK } from '../../contracts/adminCreds';

/** Canonical base64 only — Node's Buffer decoder is lenient with invalid chars. */
export const isCanonicalBase64 = (value: string, bytes: Buffer): boolean => {
  if (!/^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i.test(value)) {
    return false;
  }
  return bytes.toString('base64') === value;
};

/** Reject any field whose value is the public mask string (prevents silent secret destruction). */
export const assertNoMaskedSecretValues = (values: Record<string, string>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === PLATFORM_GLOBAL_CREDENTIAL_MASK) {
      throw new PlatformGlobalCredentialValidationError(
        `Refusing to store masked placeholder for key "${key}". Leave the field empty to keep the existing value, or enter a new secret.`,
      );
    }
  }
};

/** Drop empty values; empty object means "no secret rotation". */
export const filterNonEmptySecretValues = (
  values: Record<string, string>,
): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key || value == null || value === '') continue;
    next[key] = value;
  }
  return next;
};
