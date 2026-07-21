/**
 * Fail-closed evaluation: derive overall/checks from artifacts, bind full artifacts into core.
 * Verification recomputes semantics and digests — author-controlled summaries alone never pass.
 */
import { digestCanonical } from './canonical';
import {
  DEPENDENCY_FAIL_SEVERITIES,
  EVIDENCE_CLASS,
  EXTERNAL_PEN_TEST_STATUS,
  SECURITY_ACCEPTANCE_LANE,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { assertNoUndefinedDeep, omitUndefinedDeep } from './omitUndefined';
import type { PenAdapterDefinition } from './penManifest';
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
import { deriveChecksFromArtifacts, deriveExitCode } from './semantics';

export interface EvaluateSecurityAcceptanceInput {
  dependency: DependencyScanArtifact;
  gitSha: string;
  leakage: LeakageScanArtifact;
  /** Optional fixed timestamp for tests (ISO). */
  nowIso?: string;
  pen: PenRegressionArtifact;
  /** Inject manifest for tests. */
  penManifest?: readonly PenAdapterDefinition[];
}

export interface EvaluateSecurityAcceptanceResult {
  exitCode: number;
  report: SecurityAcceptanceReport;
}

/**
 * Build and validate a security acceptance report from real check artifacts.
 * Semantic mismatch → unavailable overall (fail closed) rather than planted pass.
 */
export const evaluateSecurityAcceptance = (
  input: EvaluateSecurityAcceptanceInput,
): EvaluateSecurityAcceptanceResult => {
  // Strip explicit undefined before schema/digest so optional fields are absent, not nullish keys.
  const dependency = dependencyScanArtifactSchema.parse(omitUndefinedDeep(input.dependency));
  const leakage = leakageScanArtifactSchema.parse(omitUndefinedDeep(input.leakage));
  const pen = penRegressionArtifactSchema.parse(omitUndefinedDeep(input.pen));

  if (!/^[a-f\d]{40}$/u.test(input.gitSha)) {
    throw new Error('gitSha must be a full lowercase 40-char sha');
  }

  const derived = deriveChecksFromArtifacts({
    dependency,
    leakage,
    manifest: input.penManifest,
    pen,
  });

  const core: SecurityAcceptanceReportCore = securityAcceptanceReportCoreSchema.parse(
    omitUndefinedDeep({
      artifacts: {
        'dependency-scan': dependency,
        'leakage-scan': leakage,
        'pen-regression': pen,
      },
      checks: derived.checks.map((check) => omitUndefinedDeep(check)),
      evidenceClass: EVIDENCE_CLASS,
      externalPenetrationTest: {
        note: 'External human production penetration testing is residual and is not claimed by repository automation.',
        status: EXTERNAL_PEN_TEST_STATUS,
      },
      gitSha: input.gitSha,
      lane: SECURITY_ACCEPTANCE_LANE,
      overall: derived.overall,
      policy: {
        dependencyFailSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      },
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
    }),
  );

  assertNoUndefinedDeep(core);
  const reportCoreSha256 = digestCanonical(core);
  const generatedAt = input.nowIso ?? new Date().toISOString();

  const redactionScan = scanForForbiddenReportContent({
    ...core,
    generatedAt,
  });

  if (redactionScan.result !== 'passed') {
    throw new Error(
      `Security acceptance report redaction rejected ${redactionScan.violations} field(s)`,
    );
  }

  const candidate: SecurityAcceptanceReport = omitUndefinedDeep({
    ...core,
    generatedAt,
    integrity: {
      redactionScan,
      reportCoreSha256,
      schemaValid: true as const,
    },
  });

  const report = securityAcceptanceReportSchema.parse(candidate);
  return {
    exitCode: deriveExitCode(report.overall),
    report,
  };
};

/**
 * Re-verify a report: recompute semantics + core digest from artifacts.
 * Does not trust author-controlled overall/checks when they disagree with artifacts.
 */
export const verifySecurityAcceptanceReport = (
  value: unknown,
  options?: { penManifest?: readonly PenAdapterDefinition[] },
): { ok: true; report: SecurityAcceptanceReport } | { ok: false; reason: string } => {
  const parsed = securityAcceptanceReportSchema.safeParse(omitUndefinedDeep(value));
  if (!parsed.success) {
    return { ok: false, reason: 'schema-mismatch' };
  }

  const report = omitUndefinedDeep(parsed.data);

  if (report.evidenceClass !== EVIDENCE_CLASS) {
    return { ok: false, reason: 'invalid-evidence-class' };
  }
  if (report.externalPenetrationTest.status !== EXTERNAL_PEN_TEST_STATUS) {
    return { ok: false, reason: 'external-pen-test-self-asserted' };
  }

  const derived = deriveChecksFromArtifacts({
    dependency: report.artifacts['dependency-scan'],
    leakage: report.artifacts['leakage-scan'],
    manifest: options?.penManifest,
    pen: report.artifacts['pen-regression'],
  });

  if (derived.semanticError) {
    return { ok: false, reason: `semantic-${derived.semanticError}` };
  }

  if (derived.overall !== report.overall) {
    return { ok: false, reason: 'overall-mismatch' };
  }

  if (derived.checks.length !== report.checks.length) {
    return { ok: false, reason: 'checks-length-mismatch' };
  }

  for (let i = 0; i < derived.checks.length; i += 1) {
    const expected = derived.checks[i]!;
    const actual = report.checks[i]!;
    if (
      expected.checkId !== actual.checkId ||
      expected.status !== actual.status ||
      expected.reason !== actual.reason
    ) {
      return { ok: false, reason: 'checks-mismatch' };
    }
  }

  const core: SecurityAcceptanceReportCore = {
    artifacts: report.artifacts,
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

  // Recompute redaction over core+envelope fields that are stored.
  const redaction = scanForForbiddenReportContent(report);
  if (redaction.result !== 'passed' || report.integrity.redactionScan.result !== 'passed') {
    return { ok: false, reason: 'redaction-failed' };
  }

  if (report.overall === 'passed' && report.checks.some((check) => check.status !== 'passed')) {
    return { ok: false, reason: 'planted-overall-pass' };
  }

  return { ok: true, report };
};

/**
 * Public pass predicate — only true after full semantic+digest verification.
 * Never trust author-controlled summary fields alone.
 */
export const isSecurityAcceptancePassed = (
  value: unknown,
  options?: { penManifest?: readonly PenAdapterDefinition[] },
): boolean => {
  const verified = verifySecurityAcceptanceReport(value, options);
  return verified.ok && verified.report.overall === 'passed';
};
