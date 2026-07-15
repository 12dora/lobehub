/**
 * Options for server-side redaction wrappers.
 *
 * Prefer over-redaction. Only opt out keys that are known-safe false positives.
 */
export interface RedactOptions {
  /**
   * TODO(M07): benign allowlist for keys that match M01 sensitive tokens
   * but are not secrets (e.g. `maxTokens`, `contextWindowTokens` match
   * the normalized token `token` via includes).
   *
   * When true, the key's value is walked recursively but the key itself
   * is not replaced with [REDACTED]. Default: no keys are benign.
   */
  isBenignKey?: (key: string) => boolean;
}
