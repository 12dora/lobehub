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
  isBenignKey: (key: string, parentKey?: string) => boolean,
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
      if (isSensitiveKey(key) && !isBenignKey(key, parentKey)) {
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
 * OAuth config keys are additionally position-scoped (see below) so the relaxation cannot
 * be abused at arbitrary depths of provider/model JSON. Keep this list scoped to
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
] as const;

/** Capability numbers — benign anywhere in AI-catalog JSON. */
const M07_BENIGN_ANYWHERE = new Set(
  ['maxTokens', 'contextWindowTokens', 'max_tokens', 'context_window_tokens'].map((key) =>
    key.toLowerCase(),
  ),
);

/** OAuth device-flow config keys — benign only directly under an `oauthDeviceFlow` object. */
const M07_BENIGN_UNDER_OAUTH_DEVICE_FLOW = new Set(
  ['refreshTokenGrant', 'tokenEndpoint', 'tokenExchangeEndpoint'].map((key) => key.toLowerCase()),
);

/**
 * M07-only redaction option. Never use it for arbitrary user-selected keys.
 * `parentKey` is the key of the enclosing object (undefined at the walked root — the
 * provider `settings` blob itself in the contracts validator), used to position-scope the
 * OAuth config keys: `settings.oauthDeviceFlow.tokenEndpoint` stays readable while a
 * smuggled `config.nested.tokenEndpoint` is still redacted/rejected.
 */
export const M07_REDACTION_OPTIONS = {
  isBenignKey: (key: string, parentKey?: string): boolean => {
    const normalized = key.toLowerCase();
    if (M07_BENIGN_ANYWHERE.has(normalized)) return true;
    const parent = parentKey?.toLowerCase();
    if (M07_BENIGN_UNDER_OAUTH_DEVICE_FLOW.has(normalized)) return parent === 'oauthdeviceflow';
    // Boolean UI flag on the provider settings root (root of the validated blob, or the
    // `settings` object inside a persisted draft/revision payload).
    if (normalized === 'showapikey') return parent === undefined || parent === 'settings';
    return false;
  },
};
