/**
 * Audit / revision redaction helpers.
 *
 * Secrets, tokens, and credential material must never enter:
 * - platform_resource_revisions.payload
 * - platform_audit_logs before_diff / after_diff
 */

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|client[_-]?secret|secret|token|password|passwd|authorization|auth[_-]?header|cookie|set[_-]?cookie|key[_-]?vaults?|encrypted[_-]?|private[_-]?key|access[_-]?key|refresh[_-]?token|bearer|credential)(?:$|[_-])/i;

const SENSITIVE_KEY_EXACT = new Set(
  [
    'apikey',
    'api_key',
    'api-key',
    'clientsecret',
    'client_secret',
    'client-secret',
    'secret',
    'token',
    'password',
    'authorization',
    'cookie',
    'set-cookie',
    'keyvaults',
    'key_vaults',
    'encryptedkeyvaults',
    'encrypted_key_vaults',
    'encryptedclientsecret',
    'encrypted_client_secret',
    'access_token',
    'refresh_token',
    'id_token',
    'private_key',
    'bearer',
  ].map((k) => k.toLowerCase()),
);

const REDACTED = '[REDACTED]';

/** Known fake placeholders used only in tests — never real material. */
const SENSITIVE_VALUE_PATTERN =
  /bearer\s+[\w.~+/=-]+|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}/i;

export const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  if (SENSITIVE_KEY_EXACT.has(key.toLowerCase()) || SENSITIVE_KEY_EXACT.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_PATTERN.test(key);
};

const redactString = (value: string): string => {
  if (SENSITIVE_VALUE_PATTERN.test(value)) return REDACTED;
  return value;
};

/**
 * Deep-redact a value for safe persistence in revision payloads / audit diffs.
 * Returns a new structure; does not mutate the input.
 */
export const redactSensitive = <T>(input: T): T => {
  return redactValue(input) as T;
};

const redactValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map((item) => redactValue(item));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(child);
    }
    return out;
  }

  return value;
};

/**
 * Assert helper for tests: ensure a JSON-able structure contains no sensitive material.
 */
export const containsSensitiveMaterial = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERN.test(value) && value !== REDACTED;
  }
  if (Array.isArray(value)) return value.some((v) => containsSensitiveMaterial(v));
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        isSensitiveKey(key) &&
        child !== REDACTED &&
        child !== undefined &&
        child !== null && // Key is sensitive and value was not redacted away
        child !== REDACTED
      )
        return true;
      if (containsSensitiveMaterial(child)) return true;
    }
  }
  return false;
};

export const REDACTED_PLACEHOLDER = REDACTED;
