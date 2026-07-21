/**
 * Evidence freshness: age is based on generatedAt only.
 * observedAt is verification-time metadata and must never make stale evidence fresh.
 */
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_MAX_EVIDENCE_AGE_MS } from './constants';

export interface FreshnessInput {
  generatedAt: string;
  /** Verification observation time — not used for age calculation. */
  observedAt?: string;
}

export interface FreshnessOptions {
  clockSkewMs?: number;
  maxAgeMs?: number;
  nowMs?: number;
}

export type FreshnessVerdict = 'fresh' | 'future' | 'invalid' | 'stale';

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

  // Optional observedAt must parse if present, but never extends freshness.
  if (input.observedAt !== undefined) {
    const observedMs = Date.parse(input.observedAt);
    if (Number.isNaN(observedMs)) {
      return { ageMs: Number.NaN, verdict: 'invalid' };
    }
  }

  const ageMs = nowMs - generatedMs;

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
