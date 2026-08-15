/**
 * Options for server-side redaction wrappers.
 *
 * Prefer over-redaction. Only opt out keys that are known-safe false positives.
 */
export interface RedactOptions {
  /**
   * Optional benign-key predicate for keys that match M01 sensitive tokens
   * but are not secrets (e.g. `maxTokens`, `contextWindowTokens` match the
   * normalized token `token` via includes). Production AI-catalog callers use
   * `M07_REDACTION_OPTIONS` from `./redact` — keep that allowlist narrow.
   *
   * When true, the key's value is walked recursively but the key itself
   * is not replaced with [REDACTED]. Default: no keys are benign.
   *
   * `parentKey` (the key of the enclosing object; undefined at the walked root)
   * lets predicates position-scope the relaxation, e.g. OAuth device-flow config
   * keys are benign only directly under `oauthDeviceFlow`.
   *
   * `value` is the key's own value, so predicates can additionally shape-check it:
   * a key name that only ever labels configuration (`allowAccessTokenPaste`,
   * `grantFlow`, `authorizationCode`) must not launder an opaque credential just
   * because it sits in the right place. Callers that cannot supply the value pass
   * `undefined`, which the M07 predicate treats as "nothing to leak".
   */
  isBenignKey?: (key: string, parentKey?: string, value?: unknown) => boolean;
}
