/**
 * Audit / revision redaction helpers.
 *
 * Secrets, tokens, and credential material must never enter:
 * - platform_resource_revisions.payload
 * - platform_audit_logs before_diff / after_diff
 */

import {
  AWS_ACCESS_KEY_PATTERN,
  GCP_API_KEY_PATTERN,
  JWT_PATTERN,
  normalizeSecretKey,
  PEM_PRIVATE_KEY_DETECT,
  PREFIXED_SECRET_PATTERN,
  SENSITIVE_KEY_EXACT,
} from './secretPatterns';

/** Strip non-alphanumerics and lowercase for key comparison (accessToken → accesstoken). */
const normalizeKey = normalizeSecretKey;

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

export interface RedactSensitiveOptions {
  /**
   * Narrow allowlist for known-safe key false positives; value-shape checks still apply.
   * `parentKey` is the key of the enclosing object (undefined at the walked root) so
   * predicates can position-scope the relaxation.
   */
  isBenignKey?: (key: string, parentKey?: string) => boolean;
}

const BEARER_VALUE_PATTERN = /\bbearer\s+([\w.~+/-]+)/giu;
const SECRET_PLACEHOLDER_PATTERN =
  /^(?:<[^>]+>|\[redacted\]|\.{3}|available|bearer|configured|disabled|enabled|expired|failed|invalid|missing|none|null|required|reset|revoked|unknown|undefined|not[-_ ]?set)$/iu;
const YOUR_PLACEHOLDER_PREFIXES = ['your ', 'your-', 'your_'] as const;
const SECRET_SCALAR_PATTERN = /^[\w.~+/-]+$/iu;

const isKnownSecretScalar = (value: string): boolean =>
  PREFIXED_SECRET_PATTERN.test(value) || JWT_PATTERN.test(value);

/**
 * Structural placeholders only (`<token>`, `required`, `your_*` prefixes).
 * Assignment values must NOT be excused merely because they contain words like
 * "fake"/"example" — real leaks and contract tests use
 * `Authorization: Bearer fake-token-value`.
 */
const isStructuralCredentialPlaceholder = (value: string): boolean => {
  if (SECRET_PLACEHOLDER_PATTERN.test(value)) return true;
  const normalized = value.toLowerCase();
  return YOUR_PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

/**
 * Stricter scalar check for fully-formed auth shapes (`Authorization: …`,
 * `bearer <value>`, `token=<value>`): a complete credential assignment is
 * refused even when its value merely LOOKS like documentation ("fake-token") —
 * only structural placeholders (`<your-token>`, `your_*`) stay excused.
 */
const isCredentialAssignmentValue = (value: string): boolean =>
  isKnownSecretScalar(value) ||
  (SECRET_SCALAR_PATTERN.test(value) && !isStructuralCredentialPlaceholder(value));

/**
 * Full shared secret-pattern catalog for write-path free-text redaction.
 * Keep in sync with {@link containsEnterpriseSecretMaterial} cloud/PEM checks.
 */
const containsSecretValueShape = (value: string): boolean => {
  if (
    PREFIXED_SECRET_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    AWS_ACCESS_KEY_PATTERN.test(value) ||
    GCP_API_KEY_PATTERN.test(value) ||
    PEM_PRIVATE_KEY_DETECT.test(value)
  ) {
    return true;
  }
  return [...value.matchAll(BEARER_VALUE_PATTERN)].some((match) =>
    match[1] ? isCredentialAssignmentValue(match[1]) : false,
  );
};

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
  if (containsSecretValueShape(value)) return REDACTED;
  return value;
};

/**
 * Deep-redact a value for safe persistence in revision payloads / audit diffs.
 * Returns a new structure; does not mutate the input.
 */
export const redactSensitive = <T>(input: T, options: RedactSensitiveOptions = {}): T => {
  return redactValue(input, options, undefined) as T;
};

const redactValue = (
  value: unknown,
  options: RedactSensitiveOptions,
  parentKey: string | undefined,
): unknown => {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, parentKey));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && !options.isBenignKey?.(key, parentKey)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(child, options, key);
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
    return containsSecretValueShape(value) && value !== REDACTED;
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

const PEM_PRIVATE_KEY_PATTERN = PEM_PRIVATE_KEY_DETECT;
const GCP_SERVICE_ACCOUNT_PATTERN = /["']type["']\s*:\s*["']service_account["']/i;
const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[-_ ]?key|api[-_ ]?secret|api[-_ ]?token|access[-_ ]?token|authorization|bearer|client[-_ ]?secret|credential|id[-_ ]?token|password|passwd|private[-_ ]?key|refresh[-_ ]?token|secret[-_ ]?access[-_ ]?key|token)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/giu;

const stringContainsSensitiveAssignment = (value: string): boolean =>
  [...value.matchAll(INLINE_SECRET_ASSIGNMENT_PATTERN)].some((match) => {
    const assignedValue = match[1] ?? match[2] ?? match[3];
    return assignedValue ? isCredentialAssignmentValue(assignedValue) : false;
  });

const SIGNED_URL_QUERY_KEYS = new Set([
  'key',
  'ocpapimsubscriptionkey',
  'sig',
  'signature',
  'subscriptionkey',
  'xamzsignature',
]);

const isSensitiveUrlQueryKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return isSensitiveKey(key) || SIGNED_URL_QUERY_KEYS.has(normalized);
};

export const isCredentialBearingUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some(isSensitiveUrlQueryKey)
    );
  } catch {
    return false;
  }
};

/** Candidate URLs sharing one non-whitespace run beyond this: assume adversarial, fail closed. */
const MAX_NESTED_URL_CANDIDATES = 32;
/** Longest single URL candidate we scan; unterminated longer runs fail closed. */
const MAX_URL_CANDIDATE_LENGTH = 4096;

const stringContainsCredentialUrl = (value: string): boolean => {
  const separator = '://';
  let searchFrom = 0;
  // Linearity guard: candidates nested inside one non-whitespace run are
  // bounded, so total work stays O(n + candidates × candidate-length) with a
  // fail-closed answer instead of quadratic scanning on adversarial input.
  let runEnd = -1;
  let nestedCandidates = 0;
  while (searchFrom < value.length) {
    const separatorIndex = value.indexOf(separator, searchFrom);
    if (separatorIndex < 0) return false;

    const minimumSchemeIndex = Math.max(0, separatorIndex - 64);
    let schemeStart = separatorIndex;
    while (schemeStart > minimumSchemeIndex && /[a-z0-9+.-]/iu.test(value[schemeStart - 1])) {
      schemeStart -= 1;
    }

    if (schemeStart < separatorIndex && /[a-z]/iu.test(value[schemeStart])) {
      nestedCandidates = separatorIndex < runEnd ? nestedCandidates + 1 : 1;
      if (nestedCandidates > MAX_NESTED_URL_CANDIDATES) return true;
      let urlEnd = separatorIndex + separator.length;
      const scanLimit = Math.min(value.length, urlEnd + MAX_URL_CANDIDATE_LENGTH);
      while (urlEnd < scanLimit && !/[\s<>"']/u.test(value[urlEnd])) urlEnd += 1;
      if (urlEnd === scanLimit && urlEnd < value.length && !/[\s<>"']/u.test(value[urlEnd])) {
        return true;
      }
      if (isCredentialBearingUrl(value.slice(schemeStart, urlEnd))) return true;
      runEnd = Math.max(runEnd, urlEnd);
      // Continue just past this separator so a credential URL nested inside the
      // candidate (e.g. "https://a|redis://user:pass@b") is still inspected.
      searchFrom = separatorIndex + separator.length;
      continue;
    }
    searchFrom = separatorIndex + separator.length;
  }
  return false;
};

/** Complete fail-closed detector for values entering safe persistence projections. */
export const containsEnterpriseSecretMaterial = (input: unknown): boolean => {
  const stack: unknown[] = [input];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    const value = stack.pop();
    visited += 1;
    if (typeof value === 'string') {
      if (
        containsSensitiveMaterial(value) ||
        PEM_PRIVATE_KEY_PATTERN.test(value) ||
        AWS_ACCESS_KEY_PATTERN.test(value) ||
        GCP_API_KEY_PATTERN.test(value) ||
        GCP_SERVICE_ACCOUNT_PATTERN.test(value) ||
        stringContainsSensitiveAssignment(value) ||
        stringContainsCredentialUrl(value)
      ) {
        return true;
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) stack.push(...value);
    else {
      for (const [key, child] of Object.entries(value)) {
        if (isSensitiveKey(key) && child !== undefined && child !== null) return true;
        stack.push(child);
      }
    }
  }
  return stack.length > 0;
};

export const REDACTED_PLACEHOLDER = REDACTED;
