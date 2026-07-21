/**
 * Production readiness evaluation.
 *
 * Production scope is NEVER taken from self-declared JSON `scope` fields.
 * It is granted only by cryptographic provenance verification against the
 * repository-pinned PRODUCTION_TRUST_POLICY (empty keys → impossible).
 */
import {
  type CheckResult,
  type EvidenceGateId,
  type EvidenceScope,
  type PreflightMode,
  REQUIRED_EVIDENCE_GATES,
} from './constants';
import { assessEvidenceFreshness, type FreshnessOptions } from './freshness';
import { shortSha } from './privacy';
import {
  createProductionReadinessReport,
  type ProductionReadinessReport,
  type ReleaseCandidate,
  releaseCandidateSchema,
  type ReleasePlan,
  releasePlanSchema,
  sortChecksDeterministic,
  sortWindowsDeterministic,
} from './schemas';
import {
  PRODUCTION_TRUST_POLICY,
  provenanceGrantsProductionScope,
  type SignedProvenanceEnvelope,
  type TrustPolicy,
  verifySignedProvenance,
} from './trust';

/** Gate evidence after adapter load (harness scopes only on the envelope). */
export interface GateEvidenceInput {
  artifactSha256: string;
  assertions?: {
    failed: number;
    passed: number;
    skipped: number;
    total: number;
  };
  candidateSha: string;
  gate: EvidenceGateId;
  generatedAt: string;
  /** Optional observedAt for verification metadata only. */
  observedAt?: string;
  /** Detached signed provenance (required for production scope). */
  provenance?: SignedProvenanceEnvelope | unknown;
  /**
   * Harness-declared scope. production-authorized is IGNORED and treated as attack.
   */
  scope: EvidenceScope;
  status: CheckResult;
}

export interface EvaluatePreflightInput {
  candidate: ReleaseCandidate;
  cleanupResult?: 'failed' | 'passed';
  evidence: GateEvidenceInput[];
  freshness?: FreshnessOptions;
  mode: PreflightMode;
  plan: ReleasePlan;
  seenNonces?: Set<string>;
  startedAtMs?: number;
  /** Tests only — CLI always uses PRODUCTION_TRUST_POLICY. */
  trustPolicy?: TrustPolicy;
}

export interface EvaluatePreflightResult {
  exitCode: number;
  report: ProductionReadinessReport;
}

const evaluateOneGate = (
  input: GateEvidenceInput | undefined,
  candidate: ReleaseCandidate,
  mode: PreflightMode,
  freshness: FreshnessOptions,
  policy: TrustPolicy,
  seenNonces: Set<string>,
): { result: CheckResult; scope: EvidenceScope; reason: string } => {
  if (!input) {
    return { result: 'not-executed', scope: 'local-harness', reason: 'missing-evidence' };
  }

  if (input.candidateSha !== candidate.gitSha) {
    return { result: 'failed', scope: 'local-harness', reason: 'candidate-mismatch' };
  }

  // Self-declared production is never trusted.
  if (input.scope === 'production-authorized' && !input.provenance) {
    return {
      result: 'failed',
      scope: 'local-harness',
      reason: 'self-declared-production-without-provenance',
    };
  }

  const freshnessVerdict = assessEvidenceFreshness(
    { generatedAt: input.generatedAt, observedAt: input.observedAt },
    freshness,
  ).verdict;
  if (freshnessVerdict !== 'fresh') {
    return {
      result: 'failed',
      scope: 'local-harness',
      reason: `freshness-${freshnessVerdict}`,
    };
  }

  // Base harness scope from declaration (clamp production away).
  let scope: EvidenceScope =
    input.scope === 'production-authorized'
      ? 'local-harness'
      : input.scope === 'ci-harness'
        ? 'ci-harness'
        : 'local-harness';

  // Production mode requires valid signature against pinned policy.
  if (mode === 'production-authorized') {
    if (!input.provenance) {
      return {
        result: 'unverified',
        scope: 'local-harness',
        reason: 'missing-production-provenance',
      };
    }
    // Gate preflight only accepts recovery-result (or non-backup gate) provenance
    // whose artifactSha256 equals the envelope/raw-report digest — never source-backup dump digests.
    const verdict = verifySignedProvenance(input.provenance, {
      expectedArtifactSha256: input.artifactSha256,
      expectedAttestationRole: input.gate === 'backup-restore' ? 'recovery-result' : undefined,
      expectedCandidateSha: candidate.gitSha,
      expectedGateId: input.gate,
      expectedReleaseId: candidate.releaseId,
      policy,
      seenNonces,
      nowMs: freshness.nowMs,
      maxAgeMs: freshness.maxAgeMs,
      clockSkewMs: freshness.clockSkewMs,
    });
    if (!verdict.ok) {
      return {
        result: 'failed',
        scope: 'local-harness',
        reason: `provenance-${verdict.reason}`,
      };
    }
    if (provenanceGrantsProductionScope(verdict)) {
      scope = 'production-authorized';
    } else {
      // Signed but not production environment → harness at best.
      scope = verdict.environment === 'ci-harness' ? 'ci-harness' : 'local-harness';
      if (mode === 'production-authorized') {
        return {
          result: 'unverified',
          scope,
          reason: 'provenance-not-production-environment',
        };
      }
    }

    // Signed status must match evidence status.
    if (verdict.payload.status !== input.status) {
      return { result: 'failed', scope, reason: 'provenance-status-mismatch' };
    }
  }

  // Zero-assertion pass is never allowed.
  if (
    input.status === 'passed' &&
    input.assertions &&
    (input.assertions.total < 1 ||
      input.assertions.passed !== input.assertions.total ||
      input.assertions.failed !== 0 ||
      input.assertions.skipped !== 0)
  ) {
    return { result: 'failed', scope, reason: 'assertions-not-all-pass' };
  }

  if (input.status === 'passed') return { result: 'passed', scope, reason: 'ok' };
  if (input.status === 'failed') return { result: 'failed', scope, reason: 'evidence-failed' };
  if (input.status === 'not-executed') {
    return { result: 'not-executed', scope, reason: 'not-executed' };
  }
  return { result: 'unverified', scope, reason: 'unverified' };
};

export const evaluateProductionReadiness = (
  input: EvaluatePreflightInput,
): EvaluatePreflightResult => {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const candidate = releaseCandidateSchema.parse(input.candidate);
  const plan = releasePlanSchema.parse(input.plan);
  const policy = input.trustPolicy ?? PRODUCTION_TRUST_POLICY;
  const seenNonces = input.seenNonces ?? new Set<string>();

  if (plan.candidateGitSha !== candidate.gitSha) {
    throw new Error('Release plan candidateGitSha does not match release candidate');
  }
  if (plan.releaseId !== candidate.releaseId) {
    throw new Error('Release plan releaseId does not match release candidate');
  }

  const byGate = new Map<EvidenceGateId, GateEvidenceInput>();
  for (const item of input.evidence) {
    if (byGate.has(item.gate)) {
      throw new Error(`Duplicate evidence for gate: ${item.gate}`);
    }
    byGate.set(item.gate, item);
  }

  const checks = sortChecksDeterministic(
    REQUIRED_EVIDENCE_GATES.map((gate) => {
      const evaluation = evaluateOneGate(
        byGate.get(gate),
        candidate,
        input.mode,
        input.freshness ?? {},
        policy,
        seenNonces,
      );
      return {
        durationMs: 0,
        gate,
        result: evaluation.result,
        scope: evaluation.scope,
      };
    }),
  );

  const windows = sortWindowsDeterministic(
    plan.windows.map((window) => ({
      id: window.id,
      order: window.order,
      result: 'passed' as const,
    })),
  );

  const cleanupResult = input.cleanupResult ?? 'passed';
  const anyFailed = checks.some((check) => check.result === 'failed');
  const anyMissing = checks.some(
    (check) => check.result === 'not-executed' || check.result === 'unverified',
  );
  const allPassed = checks.every((check) => check.result === 'passed');
  const allProduction = checks.every((check) => check.scope === 'production-authorized');

  // Production pass requires policy enablement + trusted keys + all production scopes.
  const productionPossible =
    policy.productionPassEnabled &&
    policy.trustedKeys.some((key) => !key.revoked && key.environments.includes('production'));

  let overall: 'failed' | 'passed' | 'unverified';
  if (anyFailed || cleanupResult === 'failed') {
    overall = 'failed';
  } else if (
    input.mode === 'production-authorized' &&
    productionPossible &&
    allPassed &&
    allProduction &&
    windows.every((window) => window.result === 'passed')
  ) {
    overall = 'passed';
  } else if (allPassed && input.mode !== 'production-authorized') {
    overall = 'unverified';
  } else if (anyMissing || input.mode === 'production-authorized') {
    overall = 'unverified';
  } else {
    overall = 'unverified';
  }

  if (input.mode === 'validate-harness' && overall === 'passed') {
    overall = 'unverified';
  }

  // Classification: never claim production-authorized without overall production path.
  let classification: EvidenceScope = 'local-harness';
  if (overall === 'passed' && allProduction) {
    classification = 'production-authorized';
  } else if (checks.some((check) => check.scope === 'ci-harness')) {
    classification = 'ci-harness';
  }
  if (input.mode !== 'production-authorized') {
    classification = classification === 'production-authorized' ? 'local-harness' : classification;
  }

  const report = createProductionReadinessReport({
    candidate: {
      gitSha: candidate.gitSha,
      gitShaShort: shortSha(candidate.gitSha, 12),
      latestMigrationTag: candidate.latestMigrationTag,
      releaseId: candidate.releaseId,
    },
    checks,
    classification,
    cleanupResult,
    elapsed: { milliseconds: Math.max(0, Date.now() - startedAtMs) },
    lane: 'enterprise-production-readiness',
    mode: input.mode,
    overall,
    schemaVersion: 1,
    windows,
  });

  return { exitCode: deriveExitCode(report, input.mode), report };
};

export const deriveExitCode = (report: ProductionReadinessReport, mode: PreflightMode): number => {
  if (report.redactionScan.result !== 'passed') return 1;
  if (report.cleanupResult === 'failed') return 1;
  if (mode === 'validate-harness') {
    if (report.overall === 'passed') return 1;
    return 0;
  }
  if (report.overall === 'passed') return 0;
  return 1;
};
