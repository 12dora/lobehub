import { containsEnterpriseSecretMaterial } from '../../../packages/database/src/models/platform/redact';

/**
 * Families covered by the unified enterprise detector plus explicit
 * credential-shape probes used in regression tests (synthetic only).
 */
export const SECRET_FAMILY_SAMPLES = {
  awsAccessKey: 'AKIAABCDEFGHIJKLMNOP',
  googleApiKey: 'AIzaSyA12345678901234567890123456789012',
  githubPat: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  openaiProjectKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  privateKeyBlock: '-----BEGIN PRIVATE KEY-----\nMIIEfake\n-----END PRIVATE KEY-----',
  postgresUrl: 'postgres://admin:hunter2@db.internal:5432/catalog',
  slackBotToken: 'xoxb-1234567890-abcdefghijklmnop',
} as const;

export type SecretFamily = keyof typeof SECRET_FAMILY_SAMPLES;

const ADDITIONAL_EVIDENCE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /git@[\w.-]+/u,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal)(?:[^a-z\d]|$)/iu,
] as const;

const FORBIDDEN_EVIDENCE_KEY_PATTERN =
  /ciphertext|connectionstring|credential|hostname|password|payload|secret|token|uri|url/iu;

const countAdditionalEvidenceViolations = (value: unknown, key?: string): number => {
  let violations = key && FORBIDDEN_EVIDENCE_KEY_PATTERN.test(key) ? 1 : 0;
  if (typeof value === 'string') {
    for (const pattern of ADDITIONAL_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) violations += 1;
    }
    return violations;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + countAdditionalEvidenceViolations(item),
      violations,
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (total, [childKey, childValue]) =>
        total + countAdditionalEvidenceViolations(childValue, childKey),
      violations,
    );
  }
  return violations;
};

export interface SecretScanResult {
  result: 'failed' | 'passed';
  violations: number;
}

/**
 * Scan arbitrary JSON-like values / serialized report text with the project
 * unified secret detector, then apply evidence-specific URL/host bans.
 */
export const scanForSecrets = (value: unknown): SecretScanResult => {
  let violations = 0;
  if (containsEnterpriseSecretMaterial(value)) {
    violations += 1;
  }
  if (typeof value === 'string' && containsEnterpriseSecretMaterial(value)) {
    // already counted once for string root
  }
  violations += countAdditionalEvidenceViolations(value);
  // Deduplicate double-count when unified detector also flags credential URLs:
  // prefer a positive violation count over exact cardinality for fail-closed.
  return {
    result: violations === 0 ? 'passed' : 'failed',
    violations,
  };
};

export const scanSerializedTextForSecrets = (source: string): SecretScanResult => {
  const unified = containsEnterpriseSecretMaterial(source) ? 1 : 0;
  const extras = ADDITIONAL_EVIDENCE_PATTERNS.reduce(
    (total, pattern) => total + (pattern.test(source) ? 1 : 0),
    0,
  );
  const violations = unified + extras;
  return {
    result: violations === 0 ? 'passed' : 'failed',
    violations,
  };
};

export const assertNoSecrets = (value: unknown, label: string) => {
  const scan =
    typeof value === 'string' ? scanSerializedTextForSecrets(value) : scanForSecrets(value);
  if (scan.result !== 'passed' || scan.violations !== 0) {
    throw new Error(`${label} failed secret scan (${scan.violations} violation(s))`);
  }
};
