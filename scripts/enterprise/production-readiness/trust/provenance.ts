/**
 * Signed evidence provenance: Ed25519 over canonical payload.
 * Production scope cannot be self-declared — only valid signature against policy.
 */
import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  CHECK_RESULTS,
  type CheckResult,
  type EvidenceGateId,
  REQUIRED_EVIDENCE_GATES,
} from '../constants';
import { canonicalize } from './canonical';
import { fingerprintPublicKeyBase64, signPayloadBytes, verifyPayloadBytes } from './crypto';
import {
  findTrustedKey,
  PRODUCTION_TRUST_POLICY,
  type TrustEnvironment,
  type TrustPolicy,
} from './policy';

const fullShaSchema = z.string().regex(/^[a-f\d]{40}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const isoSchema = z.string().datetime({ offset: true }).or(z.string().datetime());
const nonceSchema = z.string().regex(/^[a-f\d]{32,64}$/u);

const assertionSummarySchema = z
  .object({
    failed: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.failed + value.passed + value.skipped !== value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assertion counts must add up',
      });
    }
  });

/** Signed payload — unknown fields fail via .strict(). */
export const signedProvenancePayloadSchema = z
  .object({
    artifactSha256: sha256Schema,
    assertions: assertionSummarySchema.optional(),
    candidateSha: fullShaSchema,
    environment: z.enum(['ci-harness', 'local-harness', 'production', 'staging']),
    gateId: z.enum(REQUIRED_EVIDENCE_GATES),
    generatedAt: isoSchema,
    issuer: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    keyId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    nonce: nonceSchema,
    releaseId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    runId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    schemaVersion: z.literal(1),
    status: z.enum(CHECK_RESULTS),
  })
  .strict();

export type SignedProvenancePayload = z.infer<typeof signedProvenancePayloadSchema>;

export const signedProvenanceEnvelopeSchema = z
  .object({
    payload: signedProvenancePayloadSchema,
    publicKeyFingerprint: sha256Schema,
    schemaVersion: z.literal(1),
    signatureBase64: z.string().min(1).max(512),
  })
  .strict();

export type SignedProvenanceEnvelope = z.infer<typeof signedProvenanceEnvelopeSchema>;

export interface VerifyProvenanceOptions {
  clockSkewMs?: number;
  expectedArtifactSha256: string;
  expectedCandidateSha: string;
  expectedGateId: EvidenceGateId;
  expectedReleaseId?: string;
  maxAgeMs?: number;
  nowMs?: number;
  /** Injected only in tests — CLI always uses PRODUCTION_TRUST_POLICY. */
  policy?: TrustPolicy;
  /** Session nonce set for replay protection (mutated on success). */
  seenNonces?: Set<string>;
}

export type ProvenanceVerdict =
  | { ok: true; environment: TrustEnvironment; payload: SignedProvenancePayload }
  | { ok: false; reason: string };

export const createSignedProvenance = (input: {
  payload: SignedProvenancePayload;
  privateKeyBase64: string;
  publicKeyBase64: string;
}): SignedProvenanceEnvelope => {
  const payload = signedProvenancePayloadSchema.parse(input.payload);
  const bytes = Buffer.from(canonicalize(payload), 'utf8');
  const signatureBase64 = signPayloadBytes(bytes, input.privateKeyBase64);
  return signedProvenanceEnvelopeSchema.parse({
    payload,
    publicKeyFingerprint: fingerprintPublicKeyBase64(input.publicKeyBase64),
    schemaVersion: 1,
    signatureBase64,
  });
};

export const verifySignedProvenance = (
  raw: unknown,
  options: VerifyProvenanceOptions,
): ProvenanceVerdict => {
  const policy = options.policy ?? PRODUCTION_TRUST_POLICY;
  const parsed = signedProvenanceEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'provenance-schema-invalid' };
  }

  const envelope = parsed.data;
  const payload = envelope.payload;

  // Canonical re-serialize to reject noncanonical/malleable JSON accepted by loose parsers.
  // Caller must pass the object as parsed from JSON; we re-canonicalize for verify.
  const canonical = canonicalize(payload);
  const bytes = Buffer.from(canonical, 'utf8');

  if (payload.candidateSha !== options.expectedCandidateSha) {
    return { ok: false, reason: 'candidate-mismatch' };
  }
  if (payload.gateId !== options.expectedGateId) {
    return { ok: false, reason: 'gate-mismatch' };
  }
  if (payload.artifactSha256 !== options.expectedArtifactSha256) {
    return { ok: false, reason: 'artifact-digest-mismatch' };
  }
  if (options.expectedReleaseId && payload.releaseId !== options.expectedReleaseId) {
    return { ok: false, reason: 'release-id-mismatch' };
  }

  const trusted = findTrustedKey(policy, {
    fingerprint: envelope.publicKeyFingerprint,
    issuer: payload.issuer,
    keyId: payload.keyId,
  });
  if (!trusted) {
    return { ok: false, reason: 'unknown-or-revoked-key' };
  }
  if (fingerprintPublicKeyBase64(trusted.publicKeyBase64) !== envelope.publicKeyFingerprint) {
    return { ok: false, reason: 'fingerprint-mismatch' };
  }
  if (!trusted.environments.includes(payload.environment)) {
    return { ok: false, reason: 'environment-not-allowed-for-key' };
  }

  if (payload.environment === 'production') {
    if (!policy.productionPassEnabled) {
      return { ok: false, reason: 'production-pass-disabled-in-policy' };
    }
    if (policy.trustedKeys.length === 0) {
      return { ok: false, reason: 'no-production-keys-configured' };
    }
  }

  if (!verifyPayloadBytes(bytes, envelope.signatureBase64, trusted.publicKeyBase64)) {
    return { ok: false, reason: 'invalid-signature' };
  }

  // Freshness from generatedAt only (not observedAt).
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 72 * 60 * 60 * 1000;
  const clockSkewMs = options.clockSkewMs ?? 5 * 60 * 1000;
  const generatedMs = Date.parse(payload.generatedAt);
  if (Number.isNaN(generatedMs)) {
    return { ok: false, reason: 'invalid-generated-at' };
  }
  const ageMs = nowMs - generatedMs;
  if (ageMs < -clockSkewMs) {
    return { ok: false, reason: 'future-evidence' };
  }
  if (ageMs > maxAgeMs + clockSkewMs) {
    return { ok: false, reason: 'stale-evidence' };
  }

  if (options.seenNonces) {
    if (options.seenNonces.has(payload.nonce)) {
      return { ok: false, reason: 'replay-nonce' };
    }
    options.seenNonces.add(payload.nonce);
  }

  return { ok: true, environment: payload.environment, payload };
};

export const newNonce = (): string => randomBytes(16).toString('hex');

export const digestArtifactBytes = (bytes: Buffer | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');

export const isProductionEnvironment = (environment: TrustEnvironment): boolean =>
  environment === 'production';

export const provenanceGrantsProductionScope = (
  verdict: ProvenanceVerdict,
): verdict is { ok: true; environment: 'production'; payload: SignedProvenancePayload } =>
  verdict.ok && verdict.environment === 'production';

export type { CheckResult };
