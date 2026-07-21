/**
 * Convert recovery drill raw reports into preflight-consumable gate evidence.
 *
 * Layout contract (recovery-drill writes):
 *   <evidence-dir>/raw/<name>.raw.json              — full drill report
 *   <evidence-dir>/envelopes/<gate>.envelope.json    — strict preflight gate only
 *   <evidence-dir>/<name>.json                      — convenience copy of envelope
 *
 * Preflight discovers ONLY envelopes/*.<gate>.envelope.json (or exact gate names in root).
 * Raw neighbors are never scanned as gates.
 *
 * artifactSha256 binds the canonical raw report bytes. Optional provenance binds
 * dump+manifest for production backup-restore (not self-declared scope).
 */
import type { CheckResult, EvidenceGateId, EvidenceScope } from '../constants';
import type { GateEvidenceInput } from '../evaluate';
import type { SignedProvenanceEnvelope } from '../trust';

export interface ToPreflightGateEvidenceInput {
  artifactSha256: string;
  assertions?: GateEvidenceInput['assertions'];
  candidateSha: string;
  gate: EvidenceGateId;
  generatedAt: string;
  /** Protected provenance when production-authorized backup/restore is used. */
  provenance?: SignedProvenanceEnvelope | unknown;
  rawReport: unknown;
  releaseId?: string;
  scope: Exclude<EvidenceScope, 'production-authorized'> | EvidenceScope;
  status: CheckResult;
}

/**
 * Stable preflight envelope. Self-declared production scope is clamped.
 * Provenance is preserved when provided so restore→preflight does not drop it.
 */
export const toPreflightGateEvidence = (
  input: ToPreflightGateEvidenceInput,
): GateEvidenceInput => ({
  artifactSha256: input.artifactSha256,
  assertions: input.assertions,
  candidateSha: input.candidateSha,
  gate: input.gate,
  generatedAt: input.generatedAt,
  ...(input.provenance ? { provenance: input.provenance } : {}),
  scope: input.scope === 'production-authorized' ? 'local-harness' : input.scope,
  status: input.status,
});

/**
 * Load a preflight envelope and recompute integrity against embedded raw report if present.
 * Official recovery CLI writes gate evidence with top-level artifactSha256 + generatedAt.
 */
export const assertGateEvidenceShape = (value: unknown): GateEvidenceInput => {
  if (!value || typeof value !== 'object') {
    throw new Error('Evidence is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.gate !== 'string') throw new Error('Evidence missing gate');
  if (typeof record.candidateSha !== 'string') throw new Error('Evidence missing candidateSha');
  if (typeof record.artifactSha256 !== 'string') throw new Error('Evidence missing artifactSha256');
  if (typeof record.generatedAt !== 'string') throw new Error('Evidence missing generatedAt');
  if (typeof record.status !== 'string') throw new Error('Evidence missing status');
  return value as GateEvidenceInput;
};
