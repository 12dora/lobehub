/**
 * Shared fixtures for production-readiness unit tests.
 */
import { createHash } from 'node:crypto';

import { buildDefaultReleasePlan } from './commands';
import { BASELINE_COMMIT } from './constants';
import type { EvidenceEnvelope, ReleaseCandidate } from './schemas';

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

const baseFreshness = (nowMs = Date.now()) => ({
  generatedAt: freshTimestamp(nowMs),
});

export const buildPathBoundariesEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'path-boundaries' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'path-boundaries' }> => ({
  candidateSha: FIXTURE_CANDIDATE_SHA,
  filesScanned: 120,
  freshness: baseFreshness(),
  gate: 'path-boundaries',
  schemaVersion: 1,
  scope: 'ci-harness',
  status: 'passed',
  violationCount: 0,
  ...overrides,
});

export const buildMigrationEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'migration-compat' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'migration-compat' }> => ({
  candidateSha: FIXTURE_CANDIDATE_SHA,
  foundationGatePassed: true,
  freshness: baseFreshness(),
  gate: 'migration-compat',
  headCommitShort: FIXTURE_CANDIDATE_SHA.slice(0, 12),
  lane: 'enterprise-migration-compat',
  overall: 'unverified',
  reportSchemaVersion: 1,
  rerunResult: 'passed',
  schemaVersion: 1,
  scope: 'ci-harness',
  status: 'passed',
  syntheticResult: 'passed',
  totalMigrationCount: 136,
  ...overrides,
});

export const buildE2eEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'enterprise-admin-e2e' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'enterprise-admin-e2e' }> => ({
  assertions: { failed: 0, passed: 8, skipped: 0, total: 8 },
  candidateSha: FIXTURE_CANDIDATE_SHA,
  freshness: baseFreshness(),
  gate: 'enterprise-admin-e2e',
  schemaVersion: 1,
  scope: 'ci-harness',
  screenshotCount: 4,
  status: 'passed',
  suite: 'enterprise-admin',
  ...overrides,
});

export const buildUpstreamEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'upstream-rebase' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'upstream-rebase' }> => ({
  candidateSha: FIXTURE_CANDIDATE_SHA,
  candidateShort: FIXTURE_CANDIDATE_SHA.slice(0, 12),
  cleanupResult: 'passed',
  freshness: baseFreshness(),
  gate: 'upstream-rebase',
  lane: 'enterprise-upstream-rebase-dry-run',
  reportStatus: 'clean',
  requiredGateCount: 3,
  schemaVersion: 1,
  scope: 'ci-harness',
  status: 'passed',
  upstreamFreshness: 'verified-by-ci-fetch',
  ...overrides,
});

export const buildFailureDrillsEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'failure-drills' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'failure-drills' }> => ({
  assertions: { failed: 0, passed: 19, skipped: 0, total: 19 },
  candidateSha: FIXTURE_CANDIDATE_SHA,
  cleanupResult: 'passed',
  freshness: baseFreshness(),
  gate: 'failure-drills',
  lane: 'enterprise-failure-drills',
  scenarioCount: 4,
  schemaVersion: 1,
  scope: 'ci-harness',
  status: 'passed',
  ...overrides,
});

export const buildBackupRestoreEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'backup-restore' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'backup-restore' }> => ({
  assertions: { failed: 0, passed: 6, skipped: 0, total: 6 },
  candidateSha: FIXTURE_CANDIDATE_SHA,
  cleanupResult: 'passed',
  dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
  freshness: baseFreshness(),
  gate: 'backup-restore',
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
  scope: 'ci-harness',
  sourceBackupDigest: sha256Of('fixture-backup'),
  sourcePreserved: true,
  status: 'passed',
  ...overrides,
});

export const buildAppRollbackEvidence = (
  overrides: Partial<Extract<EvidenceEnvelope, { gate: 'app-rollback' }>> = {},
): Extract<EvidenceEnvelope, { gate: 'app-rollback' }> => ({
  assertions: { failed: 0, passed: 5, skipped: 0, total: 5 },
  baselineExecutable: true,
  baselineSha: BASELINE_COMMIT,
  candidateSha: FIXTURE_CANDIDATE_SHA,
  cleanupResult: 'passed',
  destructiveCommandsRejected: true,
  freshness: baseFreshness(),
  gate: 'app-rollback',
  lane: 'enterprise-app-rollback-drill',
  newTablesRetained: true,
  reportSchemaVersion: 1,
  rollForwardOk: true,
  schemaVersion: 1,
  scope: 'ci-harness',
  status: 'passed',
  ...overrides,
});

/** Full evidence set bound to fixture candidate (ci-harness; not production overall-pass). */
export const buildFullCiEvidence = (nowMs = Date.now()): EvidenceEnvelope[] => {
  const stamp = { freshness: baseFreshness(nowMs) };
  return [
    buildPathBoundariesEvidence(stamp),
    buildMigrationEvidence(stamp),
    buildE2eEvidence(stamp),
    buildUpstreamEvidence(stamp),
    buildFailureDrillsEvidence(stamp),
    buildBackupRestoreEvidence(stamp),
    buildAppRollbackEvidence(stamp),
  ];
};

/** Full production-authorized evidence (requires dump-applied migration overall=passed). */
export const buildFullProductionEvidence = (nowMs = Date.now()): EvidenceEnvelope[] => {
  const stamp = { freshness: baseFreshness(nowMs), scope: 'production-authorized' as const };
  return [
    buildPathBoundariesEvidence(stamp),
    buildMigrationEvidence({
      ...stamp,
      overall: 'passed',
      status: 'passed',
    }),
    buildE2eEvidence(stamp),
    buildUpstreamEvidence(stamp),
    buildFailureDrillsEvidence(stamp),
    buildBackupRestoreEvidence(stamp),
    buildAppRollbackEvidence(stamp),
  ];
};
