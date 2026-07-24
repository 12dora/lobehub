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

/**
 * Backup-restore only: binds dump + canonical source-manifest as one signed pair.
 * Required whenever gateId === 'backup-restore'.
 */
export const backupRestoreBindingSchema = z
  .object({
    /** Algorithm id for the source-manifest canonicalization. */
    inventoryVersion: z.literal(1),
    /** Manifest schema version embedded in the signed relationship. */
    manifestSchemaVersion: z.literal(1),
    /** Source DB/server/tool/schema identity digests (never raw connection strings). */
    sourceDbToolVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][\w.+-]*$/iu),
    sourceSchemaTag: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][\w.-]*$/iu),
    /** Exact canonical bytes SHA-256 of the source-manifest JSON. */
    sourceManifestSha256: sha256Schema,
  })
  .strict();

/**
 * Provenance attestation roles (RR4):
 * - source-backup: signed before restore; artifactSha256 = dump digest
 * - recovery-result: signed after raw report exists; artifactSha256 = raw report digest
 * Never reuse input as gate/result provenance.
 */
export const ATTESTATION_ROLES = ['source-backup', 'recovery-result'] as const;
export type AttestationRole = (typeof ATTESTATION_ROLES)[number];

/** Signed payload — unknown fields fail via .strict(). */
export const signedProvenancePayloadSchema = z
  .object({
    /**
     * Role of this attestation. Required for backup-restore.
     * Other gates omit role (implicit gate-result over artifact).
     */
    attestationRole: z.enum(ATTESTATION_ROLES).optional(),
    /** Primary artifact SHA-256 (dump for source-backup; raw report for recovery-result/gate). */
    artifactSha256: sha256Schema,
    assertions: assertionSummarySchema.optional(),
    /** Dump+manifest pair binding (source-backup and recovery-result both carry it). */
    backupBinding: backupRestoreBindingSchema.optional(),
    candidateSha: fullShaSchema,
    environment: z.enum(['ci-harness', 'local-harness', 'production', 'staging']),
    gateId: z.enum(REQUIRED_EVIDENCE_GATES),
    generatedAt: isoSchema,
    /**
     * SHA-256 of the canonical signed source-backup envelope.
     * Required when attestationRole === 'recovery-result'.
     */
    inputAttestationSha256: sha256Schema.optional(),
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
    /**
     * @deprecated Prefer backupBinding.sourceManifestSha256.
     */
    sourceManifestSha256: sha256Schema.optional(),
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
  .strict()
  .superRefine((value, context) => {
    // Passed payloads must bind a positive all-pass assertion summary.
    if (value.status === 'passed') {
      if (!value.assertions) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed provenance requires assertions',
          path: ['assertions'],
        });
      } else if (
        value.assertions.total < 1 ||
        value.assertions.passed !== value.assertions.total ||
        value.assertions.failed !== 0 ||
        value.assertions.skipped !== 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed provenance requires positive all-pass assertions',
          path: ['assertions'],
        });
      }
    }

    if (value.gateId !== 'backup-restore') {
      if (value.attestationRole === 'source-backup') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'source-backup role only valid for backup-restore gate',
          path: ['attestationRole'],
        });
      }
      return;
    }
    const role = value.attestationRole ?? 'source-backup';
    const manifestSha = value.backupBinding?.sourceManifestSha256 ?? value.sourceManifestSha256;
    if (!manifestSha) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backup-restore provenance requires backupBinding or sourceManifestSha256',
        path: ['backupBinding'],
      });
    }
    if (
      value.backupBinding &&
      value.sourceManifestSha256 &&
      value.backupBinding.sourceManifestSha256 !== value.sourceManifestSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backupBinding.sourceManifestSha256 must match sourceManifestSha256',
        path: ['sourceManifestSha256'],
      });
    }
    if (role === 'recovery-result' && !value.inputAttestationSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recovery-result requires inputAttestationSha256',
        path: ['inputAttestationSha256'],
      });
    }
    if (role === 'source-backup' && value.inputAttestationSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'source-backup must not carry inputAttestationSha256',
        path: ['inputAttestationSha256'],
      });
    }
  });

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

export interface ExpectedBackupBinding {
  inventoryVersion?: 1;
  manifestSchemaVersion?: 1;
  sourceDbToolVersion?: string;
  sourceManifestSha256: string;
  sourceSchemaTag?: string;
}

export interface VerifyProvenanceOptions {
  clockSkewMs?: number;
  expectedArtifactSha256: string;
  /** Required role for backup-restore layers (source-backup vs recovery-result). */
  expectedAttestationRole?: AttestationRole;
  /** Required when verifying backup-restore provenance. */
  expectedBackupBinding?: ExpectedBackupBinding;
  expectedCandidateSha: string;
  expectedGateId: EvidenceGateId;
  /**
   * Exact ISO generatedAt string from the gate envelope (and raw report).
   * Must match payload.generatedAt byte-for-byte — not merely "both fresh".
   */
  expectedGeneratedAt?: string;
  /** Required when verifying recovery-result (must match signed input envelope digest). */
  expectedInputAttestationSha256?: string;
  expectedReleaseId?: string;
  /** @deprecated Use expectedBackupBinding.sourceManifestSha256. */
  expectedSourceManifestSha256?: string;
  maxAgeMs?: number;
  nowMs?: number;
  /** Injected only in tests — CLI always uses PRODUCTION_TRUST_POLICY. */
  policy?: TrustPolicy;
  /** Session nonce set for replay protection (mutated on success). */
  seenNonces?: Set<string>;
}

export const resolveProvenanceManifestSha256 = (
  payload: SignedProvenancePayload,
): string | undefined =>
  payload.backupBinding?.sourceManifestSha256 ?? payload.sourceManifestSha256;

export const resolveAttestationRole = (
  payload: SignedProvenancePayload,
): AttestationRole | undefined => {
  if (payload.attestationRole) return payload.attestationRole;
  if (payload.gateId !== 'backup-restore') return undefined;
  // Legacy: input has backupBinding and no inputAttestationSha256.
  if (payload.inputAttestationSha256) return 'recovery-result';
  return 'source-backup';
};

/** Stable SHA-256 of a signed provenance envelope (for input→result binding). */
export const digestSignedProvenanceEnvelope = (envelope: SignedProvenanceEnvelope): string =>
  createHash('sha256').update(canonicalize(envelope)).digest('hex');

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
  if (
    options.expectedGeneratedAt !== undefined &&
    payload.generatedAt !== options.expectedGeneratedAt
  ) {
    return { ok: false, reason: 'generated-at-mismatch' };
  }

  const role = resolveAttestationRole(payload);
  if (options.expectedAttestationRole && role !== options.expectedAttestationRole) {
    return { ok: false, reason: 'attestation-role-mismatch' };
  }

  const expectedManifestSha =
    options.expectedBackupBinding?.sourceManifestSha256 ?? options.expectedSourceManifestSha256;
  const payloadManifestSha = resolveProvenanceManifestSha256(payload);

  if (payload.gateId === 'backup-restore') {
    if (!payloadManifestSha) {
      return { ok: false, reason: 'source-manifest-digest-missing' };
    }
    if (expectedManifestSha && payloadManifestSha !== expectedManifestSha) {
      return { ok: false, reason: 'source-manifest-digest-mismatch' };
    }
    if (role === 'recovery-result') {
      if (!payload.inputAttestationSha256) {
        return { ok: false, reason: 'input-attestation-missing' };
      }
      if (
        options.expectedInputAttestationSha256 &&
        payload.inputAttestationSha256 !== options.expectedInputAttestationSha256
      ) {
        return { ok: false, reason: 'input-attestation-mismatch' };
      }
    }
    if (role === 'source-backup' && payload.inputAttestationSha256) {
      return { ok: false, reason: 'source-backup-must-not-reference-input' };
    }
    if (options.expectedBackupBinding && payload.backupBinding) {
      const expected = options.expectedBackupBinding;
      const binding = payload.backupBinding;
      if (
        expected.manifestSchemaVersion !== undefined &&
        binding.manifestSchemaVersion !== expected.manifestSchemaVersion
      ) {
        return { ok: false, reason: 'manifest-schema-version-mismatch' };
      }
      if (
        expected.inventoryVersion !== undefined &&
        binding.inventoryVersion !== expected.inventoryVersion
      ) {
        return { ok: false, reason: 'inventory-version-mismatch' };
      }
      if (
        expected.sourceSchemaTag !== undefined &&
        binding.sourceSchemaTag !== expected.sourceSchemaTag
      ) {
        return { ok: false, reason: 'source-schema-tag-mismatch' };
      }
      if (
        expected.sourceDbToolVersion !== undefined &&
        binding.sourceDbToolVersion !== expected.sourceDbToolVersion
      ) {
        return { ok: false, reason: 'source-db-tool-version-mismatch' };
      }
    }
  } else if (expectedManifestSha && payloadManifestSha !== expectedManifestSha) {
    return { ok: false, reason: 'source-manifest-digest-mismatch' };
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
