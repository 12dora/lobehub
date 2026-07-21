/**
 * Shared fixtures for production-readiness unit tests.
 */
import { createHash } from 'node:crypto';

import { buildDefaultReleasePlan } from './commands';
import { BASELINE_COMMIT, type EvidenceGateId, REQUIRED_EVIDENCE_GATES } from './constants';
import type { GateEvidenceInput } from './evaluate';
import { digestArtifactJson } from './fsUtils';
import type { ReleaseCandidate } from './schemas';
import {
  createSignedProvenance,
  generateEd25519KeyPair,
  newNonce,
  type SignedProvenancePayload,
  type TrustedPublicKey,
  type TrustPolicy,
} from './trust';

export const FIXTURE_CANDIDATE_SHA = 'a'.repeat(40);
export const OTHER_CANDIDATE_SHA = 'b'.repeat(40);
export const FIXTURE_RELEASE_ID = 'rc-w8-q06-test';
export const FIXTURE_MIGRATION_TAG = '0136_m11_identity_secret_state_null_guard';

export const sha256Of = (value: string): string => createHash('sha256').update(value).digest('hex');

export const freshTimestamp = (nowMs = Date.now()): string => new Date(nowMs).toISOString();

export const buildCandidate = (overrides: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({
  dirty: false,
  gitSha: FIXTURE_CANDIDATE_SHA,
  latestMigrationTag: FIXTURE_MIGRATION_TAG,
  releaseId: FIXTURE_RELEASE_ID,
  schemaVersion: 1,
  ...overrides,
});

export const buildPlan = (candidateSha = FIXTURE_CANDIDATE_SHA) =>
  buildDefaultReleasePlan({
    candidateGitSha: candidateSha,
    releaseId: FIXTURE_RELEASE_ID,
  });

export const buildGateEvidence = (
  gate: EvidenceGateId,
  overrides: Partial<GateEvidenceInput> = {},
): GateEvidenceInput => ({
  artifactSha256: sha256Of(`artifact-${gate}`),
  assertions: { failed: 0, passed: 3, skipped: 0, total: 3 },
  candidateSha: FIXTURE_CANDIDATE_SHA,
  gate,
  generatedAt: freshTimestamp(),
  scope: 'ci-harness',
  status: 'passed',
  ...overrides,
});

export const buildFullCiEvidence = (nowMs = Date.now()): GateEvidenceInput[] =>
  REQUIRED_EVIDENCE_GATES.map((gate) =>
    buildGateEvidence(gate, {
      generatedAt: freshTimestamp(nowMs),
      scope: 'ci-harness',
    }),
  );

/** Self-declared production JSON without provenance (forge attack). */
export const buildForgedProductionEvidence = (nowMs = Date.now()): GateEvidenceInput[] =>
  REQUIRED_EVIDENCE_GATES.map((gate) =>
    buildGateEvidence(gate, {
      generatedAt: freshTimestamp(nowMs),
      scope: 'production-authorized',
      status: 'passed',
    }),
  );

export interface TestTrustBundle {
  fingerprint: string;
  issuer: string;
  keyId: string;
  policy: TrustPolicy;
  privateKeyBase64: string;
  publicKeyBase64: string;
}

export const createTestTrustBundle = (
  environments: Array<'ci-harness' | 'local-harness' | 'production' | 'staging'> = [
    'production',
    'ci-harness',
  ],
): TestTrustBundle => {
  const pair = generateEd25519KeyPair();
  const keyId = 'test-key-1';
  const issuer = 'test-issuer';
  const trusted: TrustedPublicKey = {
    environments,
    fingerprint: pair.publicKeyFingerprint,
    issuer,
    keyId,
    publicKeyBase64: pair.publicKeyBase64,
    revoked: false,
  };
  return {
    fingerprint: pair.publicKeyFingerprint,
    issuer,
    keyId,
    policy: {
      productionPassEnabled: environments.includes('production'),
      schemaVersion: 1,
      trustedKeys: [trusted],
    },
    privateKeyBase64: pair.privateKeyBase64,
    publicKeyBase64: pair.publicKeyBase64,
  };
};

export const signGateEvidence = (
  evidence: GateEvidenceInput,
  bundle: TestTrustBundle,
  environment: 'ci-harness' | 'local-harness' | 'production' | 'staging' = 'production',
  releaseId = FIXTURE_RELEASE_ID,
): GateEvidenceInput => {
  // backup-restore: build embedded raw report first so artifact digest and inputAttestation chain.
  let artifactSha256 = evidence.artifactSha256;
  let rawReport = evidence.rawReport;
  let inputAttestationSha256: string | undefined;
  let sourceManifestSha256: string | undefined;

  if (evidence.gate === 'backup-restore') {
    inputAttestationSha256 = sha256Of(`input-attestation-${evidence.candidateSha}-${releaseId}`);
    sourceManifestSha256 = sha256Of(`manifest-${evidence.candidateSha}`);
    const dumpDigest = sha256Of(`dump-${evidence.candidateSha}`);
    rawReport = {
      assertions: evidence.assertions ?? { failed: 0, passed: 6, skipped: 0, total: 6 },
      candidateSha: evidence.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      freshness: { generatedAt: evidence.generatedAt },
      gate: 'backup-restore',
      inputAttestation: {
        dumpDigest,
        inputAttestationSha256,
        role: 'source-backup',
        sourceManifestSha256,
        verified: true,
      },
      invariants: [
        { id: 'audit-logs', result: 'passed' },
        { id: 'publication-pointers', result: 'passed' },
        { id: 'required-tables', result: 'passed' },
        { id: 'resource-revisions', result: 'passed' },
        { id: 'secret-references', result: 'passed' },
        { id: 'source-preserved', result: 'passed' },
      ],
      lane: 'enterprise-backup-restore-drill',
      reportSchemaVersion: 1,
      schemaVersion: 1,
      scope: 'local-harness',
      sourceBackupDigest: dumpDigest,
      sourcePreserved: true,
      status: evidence.status,
    };
    artifactSha256 = digestArtifactJson(rawReport);
  }

  const payload: SignedProvenancePayload = {
    artifactSha256,
    assertions: evidence.assertions,
    candidateSha: evidence.candidateSha,
    environment,
    gateId: evidence.gate,
    generatedAt: evidence.generatedAt,
    issuer: bundle.issuer,
    keyId: bundle.keyId,
    nonce: newNonce(),
    releaseId,
    runId: 'run-test-1',
    schemaVersion: 1,
    status: evidence.status,
    ...(evidence.gate === 'backup-restore'
      ? {
          attestationRole: 'recovery-result' as const,
          backupBinding: {
            inventoryVersion: 1 as const,
            manifestSchemaVersion: 1 as const,
            sourceDbToolVersion: 'pg_dump-16',
            sourceManifestSha256: sourceManifestSha256!,
            sourceSchemaTag: FIXTURE_MIGRATION_TAG,
          },
          inputAttestationSha256: inputAttestationSha256!,
          sourceManifestSha256: sourceManifestSha256!,
        }
      : {}),
  };
  const provenance = createSignedProvenance({
    payload,
    privateKeyBase64: bundle.privateKeyBase64,
    publicKeyBase64: bundle.publicKeyBase64,
  });
  return {
    ...evidence,
    artifactSha256,
    provenance,
    ...(rawReport !== undefined ? { rawReport } : {}),
    // scope self-declaration is irrelevant when provenance is present
    scope: 'local-harness',
  };
};

export const buildFullSignedProductionEvidence = (
  bundle: TestTrustBundle,
  nowMs = Date.now(),
): GateEvidenceInput[] =>
  REQUIRED_EVIDENCE_GATES.map((gate) =>
    signGateEvidence(
      buildGateEvidence(gate, {
        generatedAt: freshTimestamp(nowMs),
        scope: 'local-harness',
      }),
      bundle,
      'production',
    ),
  );

export const buildAppRollbackEvidenceShape = () => ({
  assertions: { failed: 0, passed: 5, skipped: 0, total: 5 },
  baselineExecutable: true,
  baselineSha: BASELINE_COMMIT,
  candidateSha: FIXTURE_CANDIDATE_SHA,
  cleanupResult: 'passed' as const,
  destructiveCommandsRejected: true,
  freshness: { generatedAt: freshTimestamp() },
  gate: 'app-rollback' as const,
  lane: 'enterprise-app-rollback-drill' as const,
  newTablesRetained: true,
  reportSchemaVersion: 1 as const,
  rollForwardOk: true,
  schemaVersion: 1 as const,
  scope: 'local-harness' as const,
  status: 'passed' as const,
});
