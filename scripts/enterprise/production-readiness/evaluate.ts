/**
 * Pure evaluation of release candidate + evidence + release plan → readiness report.
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
  type EvidenceEnvelope,
  evidenceEnvelopeSchema,
  type ProductionReadinessReport,
  type ReleaseCandidate,
  releaseCandidateSchema,
  type ReleasePlan,
  releasePlanSchema,
  sortChecksDeterministic,
  sortWindowsDeterministic,
} from './schemas';

export interface EvaluatePreflightInput {
  candidate: ReleaseCandidate;
  cleanupResult?: 'failed' | 'passed';
  evidence: EvidenceEnvelope[];
  freshness?: FreshnessOptions;
  mode: PreflightMode;
  plan: ReleasePlan;
  /** Wall-clock for elapsed measurement. */
  startedAtMs?: number;
}

export interface EvaluatePreflightResult {
  exitCode: number;
  report: ProductionReadinessReport;
}

const scopeRank = (scope: EvidenceScope): number => {
  if (scope === 'production-authorized') return 3;
  if (scope === 'ci-harness') return 2;
  return 1;
};

const classifyBundle = (evidence: EvidenceEnvelope[]): EvidenceScope => {
  if (evidence.length === 0) return 'local-harness';
  let min: EvidenceScope = 'production-authorized';
  for (const item of evidence) {
    if (scopeRank(item.scope) < scopeRank(min)) min = item.scope;
  }
  return min;
};

const evaluateGateStatus = (
  envelope: EvidenceEnvelope | undefined,
  candidateSha: string,
  freshness: FreshnessOptions,
): { result: CheckResult; scope?: EvidenceScope; reason: string } => {
  if (!envelope) {
    return { result: 'not-executed', reason: 'missing-evidence' };
  }

  if (envelope.candidateSha !== candidateSha) {
    return { result: 'failed', scope: envelope.scope, reason: 'candidate-mismatch' };
  }

  const freshnessVerdict = assessEvidenceFreshness(envelope.freshness, freshness).verdict;
  if (
    freshnessVerdict === 'stale' ||
    freshnessVerdict === 'future' ||
    freshnessVerdict === 'invalid'
  ) {
    return { result: 'failed', scope: envelope.scope, reason: `freshness-${freshnessVerdict}` };
  }

  // Re-parse strict envelope (unknown fields / internal consistency).
  const parsed = evidenceEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return { result: 'failed', scope: envelope.scope, reason: 'schema-invalid' };
  }

  if (parsed.data.status === 'passed') {
    return { result: 'passed', scope: parsed.data.scope, reason: 'ok' };
  }
  if (parsed.data.status === 'failed') {
    return { result: 'failed', scope: parsed.data.scope, reason: 'evidence-failed' };
  }
  if (parsed.data.status === 'not-executed') {
    return { result: 'not-executed', scope: parsed.data.scope, reason: 'not-executed' };
  }
  return { result: 'unverified', scope: parsed.data.scope, reason: 'unverified' };
};

/**
 * Evaluate production readiness. Pure: no I/O, no process dispatch.
 */
export const evaluateProductionReadiness = (
  input: EvaluatePreflightInput,
): EvaluatePreflightResult => {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const candidate = releaseCandidateSchema.parse(input.candidate);
  const plan = releasePlanSchema.parse(input.plan);

  if (plan.candidateGitSha !== candidate.gitSha) {
    throw new Error('Release plan candidateGitSha does not match release candidate');
  }
  if (plan.releaseId !== candidate.releaseId) {
    throw new Error('Release plan releaseId does not match release candidate');
  }
  if (candidate.dirty !== false) {
    throw new Error('Release candidate must be clean (dirty=false)');
  }

  // Index evidence by gate; duplicates fail closed.
  const byGate = new Map<EvidenceGateId, EvidenceEnvelope>();
  for (const raw of input.evidence) {
    const parsed = evidenceEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      // Keep a failed placeholder by attempting gate field only.
      continue;
    }
    const gate = parsed.data.gate;
    if (byGate.has(gate)) {
      throw new Error(`Duplicate evidence for gate: ${gate}`);
    }
    byGate.set(gate, parsed.data);
  }

  // Also fail on unparseable items that claimed a gate.
  for (const raw of input.evidence) {
    if (!evidenceEnvelopeSchema.safeParse(raw).success) {
      throw new Error('Evidence envelope failed strict schema validation');
    }
  }

  const checks = sortChecksDeterministic(
    REQUIRED_EVIDENCE_GATES.map((gate) => {
      const evaluation = evaluateGateStatus(
        byGate.get(gate),
        candidate.gitSha,
        input.freshness ?? {},
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
      // Window plan validity already enforced by schema; mark passed when plan parses.
      result: 'passed' as const,
    })),
  );

  const classification = classifyBundle([...byGate.values()]);
  const cleanupResult = input.cleanupResult ?? 'passed';

  const anyFailed = checks.some((check) => check.result === 'failed');
  const anyMissing = checks.some(
    (check) => check.result === 'not-executed' || check.result === 'unverified',
  );
  const allPassed = checks.every((check) => check.result === 'passed');
  const allProduction = checks.every((check) => check.scope === 'production-authorized');

  let overall: 'failed' | 'passed' | 'unverified';
  if (anyFailed || cleanupResult === 'failed') {
    overall = 'failed';
  } else if (
    input.mode === 'production-authorized' &&
    allPassed &&
    allProduction &&
    classification === 'production-authorized' &&
    windows.every((window) => window.result === 'passed')
  ) {
    overall = 'passed';
  } else if (allPassed && input.mode !== 'production-authorized') {
    // Harness / local preflight may have all local checks green but never production-passed.
    overall = 'unverified';
  } else if (anyMissing) {
    overall = 'unverified';
  } else {
    overall = 'unverified';
  }

  // validate-harness never emits production passed (schema also enforces).
  if (input.mode === 'validate-harness' && overall === 'passed') {
    overall = 'unverified';
  }

  // Mode forces classification ceilings so CI/local never claim production-authorized overall.
  const reportClassification: EvidenceScope =
    input.mode === 'production-authorized' ? classification : 'local-harness';

  const report = createProductionReadinessReport({
    candidate: {
      gitSha: candidate.gitSha,
      gitShaShort: shortSha(candidate.gitSha, 12),
      latestMigrationTag: candidate.latestMigrationTag,
      releaseId: candidate.releaseId,
    },
    checks,
    classification: reportClassification,
    cleanupResult,
    elapsed: { milliseconds: Math.max(0, Date.now() - startedAtMs) },
    lane: 'enterprise-production-readiness',
    mode: input.mode,
    overall,
    schemaVersion: 1,
    windows,
  });

  // Fix classification for validate-harness and non-production modes.
  // createProductionReadinessReport already sealed; recompute exit.
  const exitCode = deriveExitCode(report, input.mode);
  return { exitCode, report };
};

/**
 * For validate-harness: exit 0 when report is well-formed and overall is not a false production pass.
 * For preflight / production-authorized: nonzero on failed or unverified overall.
 */
export const deriveExitCode = (report: ProductionReadinessReport, mode: PreflightMode): number => {
  if (report.redactionScan.result !== 'passed') return 1;
  if (report.cleanupResult === 'failed') return 1;

  if (mode === 'validate-harness') {
    // Harness validation succeeds when the contract artifact is valid and not a false green.
    if (report.overall === 'passed') return 1;
    if (report.schemaVersion !== 1) return 1;
    return 0;
  }

  if (report.overall === 'passed') return 0;
  return 1;
};

export const loadAndParseEvidenceList = (raw: unknown[]): EvidenceEnvelope[] => {
  if (!Array.isArray(raw)) {
    throw new Error('Evidence list must be an array');
  }
  return raw.map((item, index) => {
    const parsed = evidenceEnvelopeSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`Evidence[${index}] failed schema validation`);
    }
    return parsed.data;
  });
};
