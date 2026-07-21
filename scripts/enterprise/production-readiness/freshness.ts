/**
 * Evidence freshness: explicit generated/observed times, max age, clock-skew.
 */
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_MAX_EVIDENCE_AGE_MS } from './constants';

export interface FreshnessInput {
  generatedAt: string;
  observedAt?: string;
}

export interface FreshnessOptions {
  clockSkewMs?: number;
  maxAgeMs?: number;
  /** Reference "now" — injectable for tests. */
  nowMs?: number;
}

export type FreshnessVerdict = 'fresh' | 'stale' | 'future' | 'invalid';

export interface FreshnessAssessment {
  ageMs: number;
  verdict: FreshnessVerdict;
}

export const assessEvidenceFreshness = (
  input: FreshnessInput,
  options: FreshnessOptions = {},
): FreshnessAssessment => {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const nowMs = options.nowMs ?? Date.now();

  const generatedMs = Date.parse(input.generatedAt);
  if (Number.isNaN(generatedMs)) {
    return { ageMs: Number.NaN, verdict: 'invalid' };
  }

  let effectiveMs = generatedMs;
  if (input.observedAt) {
    const observedMs = Date.parse(input.observedAt);
    if (Number.isNaN(observedMs)) {
      return { ageMs: Number.NaN, verdict: 'invalid' };
    }
    // Prefer the later of generated/observed when both present (bounded capture).
    effectiveMs = Math.max(generatedMs, observedMs);
  }

  const ageMs = nowMs - effectiveMs;

  // Future beyond allowed clock skew.
  if (ageMs < -clockSkewMs) {
    return { ageMs, verdict: 'future' };
  }

  if (ageMs > maxAgeMs + clockSkewMs) {
    return { ageMs, verdict: 'stale' };
  }

  return { ageMs: Math.max(0, ageMs), verdict: 'fresh' };
};

export const isFreshEvidence = (input: FreshnessInput, options: FreshnessOptions = {}): boolean =>
  assessEvidenceFreshness(input, options).verdict === 'fresh';
