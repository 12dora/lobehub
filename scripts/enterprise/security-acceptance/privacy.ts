/**
 * Privacy helpers: never embed secret text, credentials, or registry auth in reports.
 */
import { createHash } from 'node:crypto';

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|connection_string|credential|hostname|instanceid|password|payload|private.?key|secret|token|uri|url|dump.?path|raw.?match|matched.?text|advisory.?title|overview/iu;

const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal|127\.0\.0\.1)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /(?:eyJ[\w-]{10,}\.[\w-]{10,})/u,
  // Registry credentials in tool URLs
  /\/\/[^\s/][^\s/:]*:[^\s/]+@/u,
] as const;

/** Digest keys that store fingerprints only (never secret material). */
export const ALLOWED_DIGEST_KEYS = new Set([
  'artifactSha256',
  'lineDigest',
  'lockfileSha256',
  'packageJsonSha256',
  'reportCoreSha256',
  'targetDigest',
  'toolVersion',
]);

export const countForbiddenValues = (value: unknown, key?: string): number => {
  const keyForbidden =
    key !== undefined && FORBIDDEN_KEY_PATTERN.test(key) && !ALLOWED_DIGEST_KEYS.has(key) ? 1 : 0;

  if (typeof value === 'string') {
    return keyForbidden + FORBIDDEN_VALUE_PATTERNS.filter((pattern) => pattern.test(value)).length;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countForbiddenValues(item), keyForbidden);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (total, [childKey, childValue]) => total + countForbiddenValues(childValue, childKey),
      keyForbidden,
    );
  }

  return keyForbidden;
};

export const scanForForbiddenReportContent = (value: unknown) => {
  const violations = countForbiddenValues(value);
  return {
    result: violations === 0 ? ('passed' as const) : ('failed' as const),
    violations,
  };
};

export const sha256Hex = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

/** Safe line locator: digest of the line content without storing the line. */
export const digestLine = (line: string): string => sha256Hex(line);

export const shortSha = (fullSha: string, length = 12): string => fullSha.slice(0, length);

export const isFullGitSha = (value: string): boolean => /^[a-f\d]{40}$/u.test(value);
