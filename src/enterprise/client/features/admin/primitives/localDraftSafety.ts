/**
 * Shared client-side draft recovery safety helpers.
 *
 * Intentionally self-contained: does NOT import the server/database redaction chain,
 * so admin localStorage recovery never pulls server-only modules into the SPA bundle.
 */

/**
 * Schema keys whose NAMES look credential-ish but are opaque catalog identifiers / CAS
 * tokens — never secrets. Allow-listed so a legitimate draft is not mis-flagged.
 */
export const DEFAULT_LOCAL_DRAFT_BENIGN_KEYS = [
  'allowedToolKeys',
  'connectorKey',
  'credentialMode',
  'draftToken',
  'modelKey',
  'oauthAuthorizationEndpoint',
  'oauthClientId',
  'oauthIssuer',
  'oauthScopes',
  'oauthTokenEndpoint',
  'providerKey',
  'skillKey',
] as const;

const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|secret|credential|private[-_]?key|api[-_]?key|access[-_]?key|auth[-_]?token|bearer|session[-_]?id|cookie|\btoken\b/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[\w-]{35}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[\w.-]{16,}\b/i,
  /["']?type["']?\s*:\s*["']service_account["']/i,
  // Lightweight userinfo URL form (e.g. postgres://user:pass@host). Not the server URL scanner.
  /[a-z][a-z0-9+.-]{0,32}:\/\/(?:[^\s"'/:]*:@)*[^\s"'/:]*:[^\s"'/@]+(?:@(?:[^\s"'/:]*:@)*[^\s"'/:]*:[^\s"'/@]+)*@/i,
];

/**
 * Hard cap on nodes scanned. A legitimate draft is small (a few hundred nodes); anything
 * larger is refused rather than partially scanned, so a secret can never hide past the limit.
 */
export const MAX_LOCAL_DRAFT_SCAN_NODES = 10_000;

export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

export interface LocalDraftSecretScanOptions {
  /** Extra keys treated as non-secret even when the name matches the sensitive pattern. */
  benignKeys?: Iterable<string>;
  maxScanNodes?: number;
  /**
   * Exact secret leaf values currently being edited. Any public-field string that
   * equals or contains one of these is treated as secret material (arbitrary
   * passwords/passphrases that match no built-in pattern).
   */
  secretLeaves?: Iterable<string>;
}

const isSensitiveKeyName = (key: string, benign: Set<string>) =>
  !benign.has(key.toLowerCase()) && SENSITIVE_KEY_PATTERN.test(key);

const containsSecretValue = (value: string) =>
  SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));

/**
 * FAIL-CLOSED secret scan for recovery drafts: flags secret-bearing string VALUES anywhere
 * and any sensitive foreign KEY name that is not allow-listed. Incomplete traversal (over
 * {@link MAX_LOCAL_DRAFT_SCAN_NODES}) returns `true` so oversized trees are never persisted.
 */
export const carriesLocalDraftSecretMaterial = (
  value: unknown,
  options?: LocalDraftSecretScanOptions,
): boolean => {
  const benign = new Set(
    [...(options?.benignKeys ?? DEFAULT_LOCAL_DRAFT_BENIGN_KEYS)].map((name) => name.toLowerCase()),
  );
  const secretLeaves = [...(options?.secretLeaves ?? [])].filter((leaf) => leaf.length > 0);
  const maxScanNodes = options?.maxScanNodes ?? MAX_LOCAL_DRAFT_SCAN_NODES;
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= maxScanNodes) return true;
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      if (containsSecretValue(current)) return true;
      if (secretLeaves.some((leaf) => current === leaf || current.includes(leaf))) return true;
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveKeyName(key, benign) && child != null) return true;
      stack.push(child);
    }
  }
  return false;
};
