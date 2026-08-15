/**
 * Server-side redaction entry point.
 *
 * Fact source: packages/database M01 `redact.ts` (normalize + suffix/contains
 * matching). This module re-exports that API and adds log/audit convenience
 * wrappers plus an optional benign-key hook for M07 false positives.
 *
 * Do NOT change M01 semantics from here — enhance only via wrappers.
 */

import {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
  isSensitiveKey,
  REDACTED_PLACEHOLDER,
  redactSensitive,
} from '@/database/models/platform/redact';

import type { RedactOptions } from './types';

export {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
  isSensitiveKey,
  REDACTED_PLACEHOLDER,
  redactSensitive,
};

export type { RedactOptions } from './types';

/**
 * Deep-redact with optional benign-key allowlist (wrapper over M01 rules).
 * Direction: prefer over-redaction; only skip keys explicitly marked benign.
 */
export const redactDeep = <T>(input: T, options?: RedactOptions): T => {
  if (!options?.isBenignKey) {
    return redactSensitive(input);
  }
  return walkRedact(input, options.isBenignKey, undefined) as T;
};

const walkRedact = (
  value: unknown,
  isBenignKey: (key: string, parentKey?: string, keyValue?: unknown) => boolean,
  parentKey: string | undefined,
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Value-shape redaction still goes through M01 (Bearer / sk- / ghp_ / xox*)
    return redactSensitive(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => walkRedact(item, isBenignKey, parentKey));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && !isBenignKey(key, parentKey, child)) {
        out[key] = REDACTED_PLACEHOLDER;
        continue;
      }
      out[key] = walkRedact(child, isBenignKey, key);
    }
    return out;
  }

  return value;
};

/**
 * Redact before structured logs / traces.
 * Same core rules as audit; keep a separate name so log pipelines can diverge later
 * (e.g. stricter string truncation) without touching M01.
 */
export const redactForLog = <T>(input: T, options?: RedactOptions): T => redactDeep(input, options);

/**
 * Redact before audit diffs / revision payloads at the service layer.
 * Model layer also redacts on write (defense in depth); calling this first
 * keeps intermediate objects safe if logged.
 */
export const redactForAudit = <T>(input: T, options?: RedactOptions): T =>
  redactDeep(input, options);

/**
 * Benign (non-secret) key names for AI-catalog payloads. These look sensitive to the generic
 * redactor but are model-capability numbers or OAuth device-flow *configuration* (public
 * endpoint URLs / flags from builtin provider cards — chatgpt, githubcopilot, supergrok,
 * ollama, comfyui), so they are allow-listed via {@link M07_REDACTION_OPTIONS}
 * and applied in the aiCatalog redaction paths (contracts/aiCatalog, services/aiCatalog
 * publication + persistentText). Only the key-name heuristic is relaxed: string values
 * still pass M01 value-shape redaction (prefixed vendor tokens, JWTs, `Bearer …`), and the
 * OAuth config keys are additionally position-scoped AND type-scoped (see below) so the
 * relaxation cannot be abused at arbitrary depths of provider/model JSON, nor by putting an
 * opaque credential under a configuration key name. Keep this list scoped to
 * AI-catalog use only.
 */
export const M07_BENIGN_KEY_CANDIDATES = [
  'maxTokens',
  'contextWindowTokens',
  'max_tokens',
  'context_window_tokens',
  'showApiKey',
  'refreshTokenGrant',
  'tokenEndpoint',
  'tokenExchangeEndpoint',
  'grantFlow',
  'authorizationCode',
  'allowAccessTokenPaste',
  'authorizeEndpoint',
  'redirectUri',
  'audience',
] as const;

/** Capability numbers — benign anywhere in AI-catalog JSON. */
const M07_BENIGN_ANYWHERE = new Set(
  ['maxTokens', 'contextWindowTokens', 'max_tokens', 'context_window_tokens'].map((key) =>
    key.toLowerCase(),
  ),
);

/** OAuth device-flow config keys — benign only directly under an `oauthDeviceFlow` object. */
const M07_BENIGN_UNDER_OAUTH_DEVICE_FLOW = new Set(
  [
    'refreshTokenGrant',
    'tokenEndpoint',
    'tokenExchangeEndpoint',
    // Authorization-code paste flow (chatgptweb): a grant discriminator, the public
    // authorize/redirect config object, and a boolean capability flag. None of them
    // carries a credential — `authorizationCode` names the *grant type*, not a code.
    'grantFlow',
    'authorizationCode',
    'allowAccessTokenPaste',
  ].map((key) => key.toLowerCase()),
);

/**
 * Public authorize-endpoint config — benign only directly under an
 * `authorizationCode` object (itself only reachable under `oauthDeviceFlow`).
 */
const M07_BENIGN_UNDER_AUTHORIZATION_CODE = new Set(
  ['authorizeEndpoint', 'redirectUri', 'audience'].map((key) => key.toLowerCase()),
);

/** The only grants a provider card may declare (mirrors `OAuthDeviceFlowConfigSchema`). */
const M07_OAUTH_GRANT_FLOWS = new Set(['device_code', 'authorization_code_paste']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A public configuration endpoint: an absolute http(s) URL that carries no credential in
 * its query string and no secret-shaped material anywhere. Anything else under an
 * endpoint key is an opaque value wearing a configuration name — redact it.
 */
const isPublicConfigUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 2048) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  if (isCredentialBearingUrl(value)) return false;
  return !containsSensitiveMaterial(value);
};

/**
 * Shape contract for every position-scoped OAuth config key. The key name alone is NOT
 * evidence that a value is configuration: `authorizationCode` names the *grant type*, but
 * an attacker can put a live authorization code there, and a bounded-JSON `settings` blob
 * would happily carry it. So each key must also hold the type its card declares.
 *
 * `undefined` / `null` is benign by definition — there is nothing to leak.
 */
const M07_OAUTH_VALUE_SHAPES: Record<string, (value: unknown) => boolean> = {
  // `allowAccessTokenPaste`: a capability flag, never a token.
  allowaccesstokenpaste: (value) => typeof value === 'boolean',
  audience: isPublicConfigUrl,
  authorizationcode: (value) =>
    // A plain object whose own keys are exactly the public authorize config, all of them
    // string leaves. The leaves are re-checked individually while walking, so a bad URL
    // is redacted on its own instead of blinding the whole object.
    isPlainObject(value) &&
    Object.entries(value).every(
      ([childKey, childValue]) =>
        M07_BENIGN_UNDER_AUTHORIZATION_CODE.has(childKey.toLowerCase()) &&
        typeof childValue === 'string',
    ),
  authorizeendpoint: isPublicConfigUrl,
  grantflow: (value) => typeof value === 'string' && M07_OAUTH_GRANT_FLOWS.has(value),
  redirecturi: isPublicConfigUrl,
  refreshtokengrant: (value) => typeof value === 'boolean',
  // `showApiKey` toggles a form field; a string there is not a UI flag.
  showapikey: (value) => typeof value === 'boolean',
  tokenendpoint: isPublicConfigUrl,
  tokenexchangeendpoint: isPublicConfigUrl,
};

const hasBenignShape = (normalizedKey: string, value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  const check = M07_OAUTH_VALUE_SHAPES[normalizedKey];
  return check ? check(value) : false;
};

/**
 * M07-only redaction option. Never use it for arbitrary user-selected keys.
 *
 * `parentKey` is the key of the enclosing object (undefined at the walked root — the
 * provider `settings` blob itself in the contracts validator), used to position-scope the
 * OAuth config keys: `settings.oauthDeviceFlow.tokenEndpoint` stays readable while a
 * smuggled `config.nested.tokenEndpoint` is still redacted/rejected.
 *
 * `value` adds the second half of the gate: right position AND declared type. A
 * correctly-placed but wrongly-typed value (`authorizationCode: 'opaque-code'`,
 * `allowAccessTokenPaste: 'opaque-secret'`) is NOT benign.
 */
export const M07_REDACTION_OPTIONS = {
  isBenignKey: (key: string, parentKey?: string, value?: unknown): boolean => {
    const normalized = key.toLowerCase();
    if (M07_BENIGN_ANYWHERE.has(normalized)) return true;
    const parent = parentKey?.toLowerCase();
    if (M07_BENIGN_UNDER_OAUTH_DEVICE_FLOW.has(normalized))
      return parent === 'oauthdeviceflow' && hasBenignShape(normalized, value);
    if (M07_BENIGN_UNDER_AUTHORIZATION_CODE.has(normalized))
      return parent === 'authorizationcode' && hasBenignShape(normalized, value);
    // Boolean UI flag on the provider settings root (root of the validated blob, or the
    // `settings` object inside a persisted draft/revision payload).
    if (normalized === 'showapikey')
      return (parent === undefined || parent === 'settings') && hasBenignShape(normalized, value);
    return false;
  },
};
