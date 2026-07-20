/**
 * Privacy / redaction helpers for migration-compat reports and dump intake.
 * Never echo raw secrets, SQL, connection strings, or dump paths into reports.
 */

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|connection_string|credential|hostname|instanceid|password|payload|private.?key|secret|token|uri|url|dump.?path|dump.?url|sql|error.?message|stack/iu;

const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal|127\.0\.0\.1)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /(?:eyJ[\w-]{10,}\.[\w-]{10,})/u,
] as const;

/** Patterns that make an external dump unsafe to accept. */
export const DUMP_PRIVACY_REJECT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /postgres(?:ql)?:\/\/[^\s'"]+/iu,
  /(?:bearer|password|secret|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /COPY\s+public\.(?:accounts|sessions|verifications)\b/iu,
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

export const scanDumpPrivacy = (content: string | Buffer): 'passed' | 'failed' => {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  // Bound scan work for large dumps; sample head/tail and mid window.
  const head = text.slice(0, 256_000);
  const midStart = Math.max(0, Math.floor(text.length / 2) - 64_000);
  const mid = text.slice(midStart, midStart + 128_000);
  const tail = text.slice(Math.max(0, text.length - 256_000));
  const sample = `${head}\n${mid}\n${tail}`;

  for (const pattern of DUMP_PRIVACY_REJECT_PATTERNS) {
    if (pattern.test(sample)) return 'failed';
  }
  return 'passed';
};

export const shortSha = (fullSha: string): string => fullSha.slice(0, 7).toLowerCase();

export const isFullGitSha = (value: string): boolean => /^[a-f\d]{40}$/u.test(value);
