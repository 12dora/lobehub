/**
 * Convert recovery drill raw reports into preflight-consumable gate evidence.
 *
 * Layout contract (recovery-drill writes):
 *   <evidence-dir>/raw/<name>.raw.json              — full drill report
 *   <evidence-dir>/envelopes/<gate>.envelope.json    — strict preflight gate
 *   <evidence-dir>/<name>.json                      — convenience copy of envelope
 *
 * Envelopes for backup-restore **embed** the sanitized raw report so preflight
 * can recompute artifactSha256 and extract inputAttestation without path/TOCTOU.
 */
import { z } from 'zod';

import type { CheckResult, EvidenceGateId, EvidenceScope } from '../constants';
import type { GateEvidenceInput } from '../evaluate';
import { digestArtifactJson } from '../fsUtils';
import type { SignedProvenanceEnvelope } from '../trust';

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);

/** Strict sanitized input-attestation reference (no secrets). */
export const inputAttestationRefSchema = z
  .object({
    dumpDigest: sha256Schema,
    inputAttestationSha256: sha256Schema,
    role: z.literal('source-backup'),
    sourceManifestSha256: sha256Schema,
    verified: z.literal(true),
  })
  .strict();

export type InputAttestationRef = z.infer<typeof inputAttestationRefSchema>;

export interface ToPreflightGateEvidenceInput {
  artifactSha256: string;
  assertions?: GateEvidenceInput['assertions'];
  candidateSha: string;
  gate: EvidenceGateId;
  generatedAt: string;
  /** Protected provenance when production-authorized recovery-result is used. */
  provenance?: SignedProvenanceEnvelope | unknown;
  /** Embedded sanitized raw report (required for backup-restore production chain). */
  rawReport: unknown;
  releaseId?: string;
  scope: Exclude<EvidenceScope, 'production-authorized'> | EvidenceScope;
  status: CheckResult;
}

/**
 * Stable preflight envelope. Embeds rawReport for digest recompute + input chain.
 * Self-declared production scope is clamped.
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
  rawReport: input.rawReport,
  scope: input.scope === 'production-authorized' ? 'local-harness' : input.scope,
  status: input.status,
});

/**
 * Load a preflight envelope. When rawReport is embedded, recompute digest and
 * require equality with artifactSha256 (fail closed on mismatch).
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

  if (record.rawReport !== undefined) {
    const recomputed = digestArtifactJson(record.rawReport);
    if (recomputed !== record.artifactSha256) {
      throw new Error('Evidence rawReport digest does not match artifactSha256');
    }
  } else if (record.gate === 'backup-restore') {
    // Production chain requires embedded raw; harness fixtures may omit until signed.
    // Loader still accepts but evaluate production will fail closed without rawReport.
  }

  return value as GateEvidenceInput;
};

export const extractInputAttestationFromRawReport = (
  rawReport: unknown,
): InputAttestationRef | undefined => {
  if (!rawReport || typeof rawReport !== 'object') return undefined;
  const record = rawReport as Record<string, unknown>;
  const parsed = inputAttestationRefSchema.safeParse(record.inputAttestation);
  return parsed.success ? parsed.data : undefined;
};

/** Cross-check raw report fields against envelope top-level for backup-restore. */
export const assertRawReportMatchesEnvelope = (
  envelope: GateEvidenceInput,
): { ok: true } | { ok: false; reason: string } => {
  if (envelope.gate !== 'backup-restore') return { ok: true };
  if (envelope.rawReport === undefined) {
    return { ok: false, reason: 'missing-raw-report' };
  }
  const recomputed = digestArtifactJson(envelope.rawReport);
  if (recomputed !== envelope.artifactSha256) {
    return { ok: false, reason: 'raw-report-digest-mismatch' };
  }
  const raw = envelope.rawReport as Record<string, unknown>;
  if (raw.gate !== 'backup-restore') {
    return { ok: false, reason: 'raw-report-gate-mismatch' };
  }
  if (raw.candidateSha !== envelope.candidateSha) {
    return { ok: false, reason: 'raw-report-candidate-mismatch' };
  }
  if (raw.status !== envelope.status) {
    return { ok: false, reason: 'raw-report-status-mismatch' };
  }
  const freshness = raw.freshness as { generatedAt?: string } | undefined;
  if (freshness?.generatedAt !== envelope.generatedAt) {
    return { ok: false, reason: 'raw-report-generatedAt-mismatch' };
  }
  return { ok: true };
};
