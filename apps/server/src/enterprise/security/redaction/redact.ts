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
  isSensitiveKey,
  REDACTED_PLACEHOLDER,
  redactSensitive,
} from '@/database/models/platform';

import type { RedactOptions } from './types';

export { containsSensitiveMaterial, isSensitiveKey, REDACTED_PLACEHOLDER, redactSensitive };

export type { RedactOptions } from './types';

/**
 * Deep-redact with optional benign-key allowlist (wrapper over M01 rules).
 * Direction: prefer over-redaction; only skip keys explicitly marked benign.
 */
export const redactDeep = <T>(input: T, options?: RedactOptions): T => {
  if (!options?.isBenignKey) {
    return redactSensitive(input);
  }
  return walkRedact(input, options.isBenignKey) as T;
};

const walkRedact = (value: unknown, isBenignKey: (key: string) => boolean): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Value-shape redaction still goes through M01 (Bearer / sk- / ghp_ / xox*)
    return redactSensitive(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => walkRedact(item, isBenignKey));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && !isBenignKey(key)) {
        out[key] = REDACTED_PLACEHOLDER;
        continue;
      }
      out[key] = walkRedact(child, isBenignKey);
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
 * TODO(M07): suggested benign keys for AI catalog payloads.
 * Not applied by default — M07 should pass `isBenignKey` when wiring.
 * Keep empty until product confirms the allowlist.
 */
export const M07_BENIGN_KEY_CANDIDATES = [
  'maxTokens',
  'contextWindowTokens',
  'max_tokens',
  'context_window_tokens',
] as const;
