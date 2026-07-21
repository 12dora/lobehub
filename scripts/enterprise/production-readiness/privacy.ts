/**
 * Privacy / redaction helpers for production-readiness evidence and reports.
 * Never emit connection strings, hostnames, tokens, ciphertext, raw DB rows,
 * commit messages, or private payloads.
 */

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|connection_string|credential|hostname|instanceid|password|payload|private.?key|secret|token|uri|url|dump.?path|dump.?url|sql|error.?message|stack|commit.?message|raw.?row/iu;

const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal|127\.0\.0\.1)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /(?:eyJ[\w-]{10,}\.[\w-]{10,})/u,
  /kms:\/\/[^\s"']+/iu,
] as const;

export const countForbiddenValues = (value: unknown, key?: string): number => {
  const violations = key && FORBIDDEN_KEY_PATTERN.test(key) ? 1 : 0;

  if (typeof value === 'string') {
    return violations + FORBIDDEN_VALUE_PATTERNS.filter((pattern) => pattern.test(value)).length;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countForbiddenValues(item), violations);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (total, [childKey, childValue]) => total + countForbiddenValues(childValue, childKey),
      violations,
    );
  }

  return violations;
};

export const scanForForbiddenReportContent = (value: unknown) => {
  const violations = countForbiddenValues(value);
  return {
    result: violations === 0 ? ('passed' as const) : ('failed' as const),
    violations,
  };
};

export const shortSha = (fullSha: string, length = 12): string =>
  fullSha.slice(0, length).toLowerCase();

export const isFullGitSha = (value: string): boolean => /^[a-f\d]{40}$/u.test(value);

export const isShortGitSha = (value: string, length = 12): boolean =>
  new RegExp(`^[a-f\\d]{${length}}$`, 'u').test(value);

/**
 * Keys allowed even when they match a forbidden-key substring (digest/classification only).
 * These store fingerprints/digests, never secret material.
 */
export const ALLOWED_DIGEST_KEYS = new Set([
  'secretFingerprintDigest',
  'secretRefDigest',
  'ciphertextDigest',
  'keyIdDigest',
  'fingerprintDigest',
  'refDigest',
  'sourceBackupDigest',
  'contentSha256',
  'aggregateDigest',
  'payloadChecksumDigest',
]);
