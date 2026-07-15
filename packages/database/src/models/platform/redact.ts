/**
 * Audit / revision redaction helpers.
 *
 * Secrets, tokens, and credential material must never enter:
 * - platform_resource_revisions.payload
 * - platform_audit_logs before_diff / after_diff
 */

/** Strip non-alphanumerics and lowercase for key comparison (accessToken → accesstoken). */
const normalizeKey = (key: string): string => key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Normalized forms of known sensitive keys.
 * Stored as normalized strings so camelCase / snake_case / kebab-case all match.
 */
const SENSITIVE_KEY_EXACT = new Set(
  [
    'apikey',
    'apisecret',
    'apitoken',
    'clientsecret',
    'secret',
    'token',
    'password',
    'passwd',
    'authorization',
    'authorizationheader',
    'authheader',
    'cookie',
    'setcookie',
    'keyvault',
    'keyvaults',
    'encryptedkeyvaults',
    'encryptedclientsecret',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'privatekey',
    'accesskey',
    'accesskeyid',
    'secretaccesskey',
    'awssecretaccesskey',
    'openaiapikey',
    'xapikey',
    'bearer',
    'credential',
    'credentials',
  ].map(normalizeKey),
);

/**
 * Substring / suffix tokens on the normalized key.
 * Catches compound names: openaiApiKey → openaiapikey, awsSecretAccessKey, xApiKey, etc.
 */
const SENSITIVE_NORMALIZED_TOKENS = [
  'apikey',
  'apisecret',
  'apitoken',
  'clientsecret',
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'accesskey',
  'secretaccesskey',
  'keyvault',
] as const;

const REDACTED = '[REDACTED]';

/** Known fake placeholders used only in tests — never real material. */
const SENSITIVE_VALUE_PATTERN =
  /bearer\s+[\w.~+/=-]+|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}/i;

export const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (!normalized) return false;

  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;

  // contains / endsWith on normalized form (accessToken, openaiApiKey, awsSecretAccessKey, …)
  for (const token of SENSITIVE_NORMALIZED_TOKENS) {
    if (normalized === token || normalized.endsWith(token) || normalized.includes(token)) {
      return true;
    }
  }

  return false;
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
 * Flags unredacted sensitive keys (any value other than [REDACTED]) and known secret value shapes.
 */
export const containsSensitiveMaterial = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERN.test(value) && value !== REDACTED;
  }
  if (Array.isArray(value)) return value.some((v) => containsSensitiveMaterial(v));
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Sensitive key still holding non-redacted content
      if (isSensitiveKey(key) && child !== REDACTED && child !== undefined && child !== null) {
        return true;
      }
      if (containsSensitiveMaterial(child)) return true;
    }
  }
  return false;
};

export const REDACTED_PLACEHOLDER = REDACTED;
