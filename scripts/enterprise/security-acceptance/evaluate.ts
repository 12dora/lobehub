/**
 * Fail-closed evaluation of security-acceptance check artifacts into a report.
 * Never emits overall=passed from planted self-asserted booleans without artifacts.
 */
import { digestCanonical } from './canonical';
import {
  DEPENDENCY_FAIL_SEVERITIES,
  EVIDENCE_CLASS,
  EXTERNAL_PEN_TEST_STATUS,
  type OverallStatus,
  REQUIRED_CHECK_IDS,
  SECURITY_ACCEPTANCE_LANE,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { scanForForbiddenReportContent } from './privacy';
import {
  type DependencyScanArtifact,
  dependencyScanArtifactSchema,
  type LeakageScanArtifact,
  leakageScanArtifactSchema,
  type PenRegressionArtifact,
  penRegressionArtifactSchema,
  type SecurityAcceptanceReport,
  type SecurityAcceptanceReportCore,
  securityAcceptanceReportCoreSchema,
  securityAcceptanceReportSchema,
} from './schemas';

export interface EvaluateSecurityAcceptanceInput {
  dependency: DependencyScanArtifact;
  gitSha: string;
  leakage: LeakageScanArtifact;
  /** Optional fixed timestamp for tests (ISO). */
  nowIso?: string;
  pen: PenRegressionArtifact;
}

export interface EvaluateSecurityAcceptanceResult {
  exitCode: number;
  report: SecurityAcceptanceReport;
}

const deriveOverall = (
  statuses: Array<'passed' | 'failed' | 'unavailable' | 'not-executed'>,
): OverallStatus => {
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'failed';
};

const deriveExitCode = (overall: OverallStatus): number => {
  if (overall === 'passed') return 0;
  if (overall === 'unavailable') return 2;
  return 1;
};

/**
 * Build and validate a security acceptance report from real check artifacts.
 * Schema mismatch / redaction failure / status disagreement → throws (fail closed).
 */
export const evaluateSecurityAcceptance = (
  input: EvaluateSecurityAcceptanceInput,
): EvaluateSecurityAcceptanceResult => {
  const dependency = dependencyScanArtifactSchema.parse(input.dependency);
  const leakage = leakageScanArtifactSchema.parse(input.leakage);
  const pen = penRegressionArtifactSchema.parse(input.pen);

  if (!/^[a-f\d]{40}$/u.test(input.gitSha)) {
    throw new Error('gitSha must be a full lowercase 40-char sha');
  }

  const toCheck = (
    checkId: (typeof REQUIRED_CHECK_IDS)[number],
    status: 'passed' | 'failed' | 'unavailable' | 'not-executed',
    reason: string | undefined,
  ) => {
    // Omit undefined reason so canonical digests never include undefined keys.
    return reason === undefined ? { checkId, status } : { checkId, reason, status };
  };

  const checks = [
    toCheck('dependency-scan', dependency.status, dependency.reason),
    toCheck('leakage-scan', leakage.status, leakage.reason),
    toCheck('pen-regression', pen.status, pen.reason),
  ];

  // Guard against incomplete required set (parse would also catch, but fail early).
  if (checks.length !== REQUIRED_CHECK_IDS.length) {
    throw new Error('incomplete required checks');
  }

  const overall = deriveOverall(checks.map((check) => check.status));

  const core: SecurityAcceptanceReportCore = securityAcceptanceReportCoreSchema.parse({
    checks,
    evidenceClass: EVIDENCE_CLASS,
    externalPenetrationTest: {
      note: 'External human production penetration testing is residual and is not claimed by repository automation.',
      status: EXTERNAL_PEN_TEST_STATUS,
    },
    gitSha: input.gitSha,
    lane: SECURITY_ACCEPTANCE_LANE,
    overall,
    policy: {
      dependencyFailSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
    },
    schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
  });

  const reportCoreSha256 = digestCanonical(core);
  const generatedAt = input.nowIso ?? new Date().toISOString();

  const candidate: SecurityAcceptanceReport = {
    ...core,
    artifacts: {
      'dependency-scan': dependency,
      'leakage-scan': leakage,
      'pen-regression': pen,
    },
    generatedAt,
    integrity: {
      redactionScan: scanForForbiddenReportContent({
        ...core,
        artifacts: {
          'dependency-scan': dependency,
          'leakage-scan': leakage,
          'pen-regression': pen,
        },
      }),
      reportCoreSha256,
      schemaValid: true,
    },
  };

  if (candidate.integrity.redactionScan.result !== 'passed') {
    throw new Error(
      `Security acceptance report redaction rejected ${candidate.integrity.redactionScan.violations} field(s)`,
    );
  }

  const report = securityAcceptanceReportSchema.parse(candidate);
  return {
    exitCode: deriveExitCode(report.overall),
    report,
  };
};

/**
 * Re-verify a report: schema, core digest, redaction, and no planted pass without artifact agreement.
 */
export const verifySecurityAcceptanceReport = (
  value: unknown,
): { ok: true; report: SecurityAcceptanceReport } | { ok: false; reason: string } => {
  const parsed = securityAcceptanceReportSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'schema-mismatch' };
  }

  const report = parsed.data;
  const core: SecurityAcceptanceReportCore = {
    checks: report.checks,
    evidenceClass: report.evidenceClass,
    externalPenetrationTest: report.externalPenetrationTest,
    gitSha: report.gitSha,
    lane: report.lane,
    overall: report.overall,
    policy: report.policy,
    schemaVersion: report.schemaVersion,
  };

  const expectedDigest = digestCanonical(core);
  if (expectedDigest !== report.integrity.reportCoreSha256) {
    return { ok: false, reason: 'report-core-digest-mismatch' };
  }

  if (report.integrity.redactionScan.result !== 'passed') {
    return { ok: false, reason: 'redaction-failed' };
  }

  if (report.overall === 'passed' && report.checks.some((check) => check.status !== 'passed')) {
    return { ok: false, reason: 'planted-overall-pass' };
  }

  if (report.evidenceClass !== EVIDENCE_CLASS) {
    return { ok: false, reason: 'invalid-evidence-class' };
  }

  if (report.externalPenetrationTest.status !== EXTERNAL_PEN_TEST_STATUS) {
    return { ok: false, reason: 'external-pen-test-self-asserted' };
  }

  return { ok: true, report };
};
