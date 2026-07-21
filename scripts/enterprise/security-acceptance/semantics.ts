/**
 * Fail-closed semantic derivation for security-acceptance artifacts.
 * Verification recomputes overall/checks from artifacts — never trusts summaries alone.
 */
import { type CheckStatus, DEPENDENCY_FAIL_SEVERITIES, type OverallStatus } from './constants';
import {
  PEN_REGRESSION_MANIFEST,
  type PenAdapterDefinition,
  REQUIRED_PEN_ADAPTER_IDS,
} from './penManifest';
import type { DependencyScanArtifact, LeakageScanArtifact, PenRegressionArtifact } from './schemas';
import { validateSkipMultiset } from './skipMultiset';

export interface DerivedCheck {
  checkId: 'dependency-scan' | 'leakage-scan' | 'pen-regression';
  reason?: string;
  status: CheckStatus;
}

/**
 * overall:
 * - passed only if every check passed
 * - failed if any failed or not-executed
 * - unavailable if any unavailable and none failed/not-executed
 */
export const deriveOverall = (statuses: CheckStatus[]): OverallStatus => {
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'failed' || status === 'not-executed')) return 'failed';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'failed';
};

export const deriveExitCode = (overall: OverallStatus): number => {
  if (overall === 'passed') return 0;
  if (overall === 'unavailable') return 2;
  return 1;
};

const failSeveritiesMatch = (actual: readonly string[]): boolean =>
  actual.length === DEPENDENCY_FAIL_SEVERITIES.length &&
  DEPENDENCY_FAIL_SEVERITIES.every((severity, index) => actual[index] === severity);

/** Returns undefined when artifact status/counts/exit/tool relationships are consistent. */
export const validateDependencySemantics = (
  artifact: DependencyScanArtifact,
): string | undefined => {
  if (artifact.checkId !== 'dependency-scan') return 'dependency-check-id';
  if (!failSeveritiesMatch(artifact.failSeverities)) return 'dependency-fail-severities-mismatch';

  const counts = artifact.severityCounts;
  const policyFromCounts = counts ? counts.high + counts.critical : undefined;

  if (artifact.status === 'passed') {
    if (artifact.policyHits !== 0) return 'dependency-passed-with-policy-hits';
    if (!counts) return 'dependency-passed-missing-counts';
    if (policyFromCounts !== 0) return 'dependency-passed-nonzero-high-critical';
    if (artifact.tool.version === 'unknown') return 'dependency-passed-unknown-tool';
    if (artifact.exitCode !== 0) return 'dependency-passed-nonzero-exit';
    if (!artifact.target.lockfileSha256) return 'dependency-passed-missing-lock-digest';
    return undefined;
  }

  if (artifact.status === 'failed') {
    if (!counts) return 'dependency-failed-missing-counts';
    if (policyFromCounts !== artifact.policyHits) return 'dependency-policy-hits-mismatch';
    if (artifact.policyHits <= 0) return 'dependency-failed-without-policy-hits';
    // Advisory path: pnpm returns 1 when audit-level is breached.
    if (artifact.exitCode !== undefined && artifact.exitCode !== 0 && artifact.exitCode !== 1) {
      return 'dependency-unexpected-exit';
    }
    return undefined;
  }

  if (artifact.status === 'unavailable') {
    if (!artifact.reason) return 'dependency-unavailable-missing-reason';
    return undefined;
  }

  return 'dependency-invalid-status';
};

export const validateLeakageSemantics = (artifact: LeakageScanArtifact): string | undefined => {
  if (artifact.checkId !== 'leakage-scan') return 'leakage-check-id';

  if (artifact.violationCount <= 500) {
    if (artifact.violationCount !== artifact.findings.length) {
      return 'leakage-violation-count-mismatch';
    }
  } else if (artifact.findings.length !== 500) {
    return 'leakage-findings-cap-mismatch';
  }

  const coverage = artifact.coverage;
  if (!coverage) return 'leakage-missing-coverage';
  if (coverage.rootsRequired < 1) return 'leakage-roots-required-zero';
  if (coverage.rootsPresent + coverage.rootsMissing !== coverage.rootsRequired) {
    return 'leakage-roots-sum-mismatch';
  }

  if (artifact.status === 'passed') {
    if (artifact.violationCount !== 0) return 'leakage-passed-with-violations';
    if (artifact.filesScanned < 1) return 'leakage-passed-zero-files';
    if (coverage.rootsMissing > 0) return 'leakage-passed-missing-roots';
    if (coverage.symlinkEncounters > 0) return 'leakage-passed-with-symlinks';
    if (coverage.oversizedSkipped > 0) return 'leakage-passed-with-oversized';
    if (coverage.unreadableFiles > 0) return 'leakage-passed-with-unreadable';
    if (coverage.walkErrors > 0) return 'leakage-passed-with-walk-errors';
    return undefined;
  }

  if (artifact.status === 'failed') {
    if (!artifact.reason) return 'leakage-failed-missing-reason';
    return undefined;
  }

  if (artifact.status === 'unavailable') {
    if (!artifact.reason) return 'leakage-unavailable-missing-reason';
    return undefined;
  }

  return 'leakage-invalid-status';
};

export const validatePenAdapterAgainstManifest = (
  adapter: PenRegressionArtifact['adapters'][number],
  definition: PenAdapterDefinition,
): string | undefined => {
  if (adapter.adapterId !== definition.id) return 'pen-adapter-id-mismatch';
  if (adapter.category !== definition.category) return 'pen-category-mismatch';
  if (adapter.targets.length !== definition.testFiles.length) return 'pen-targets-length-mismatch';
  for (let i = 0; i < definition.testFiles.length; i += 1) {
    if (adapter.targets[i] !== definition.testFiles[i]) return 'pen-targets-mismatch';
  }

  if (adapter.status === 'passed') {
    if (!adapter.assertions) return 'pen-passed-missing-assertions';
    const { failed, passed, skipped, total } = adapter.assertions;
    if (failed !== 0) return 'pen-passed-with-failures';
    if (total <= 0) return 'pen-passed-zero-total';
    if (passed + skipped + failed !== total) return 'pen-assertion-sum';
    if (adapter.exitCode !== 0) return 'pen-passed-nonzero-exit';
    const titles = adapter.skippedTitles ?? [];
    if (titles.length !== skipped) return 'pen-skipped-titles-count';
    // Detect duplicate listing inconsistency is handled by multiset vs assertion count.
    const skipVerdict = validateSkipMultiset(titles, definition.expectedSkips ?? []);
    if (!skipVerdict.ok) return `pen-${skipVerdict.reason}`;
    return undefined;
  }

  if (adapter.status === 'not-executed') {
    if (!adapter.reason) return 'pen-not-executed-missing-reason';
    return undefined;
  }

  if (adapter.status === 'failed' || adapter.status === 'unavailable') {
    return undefined;
  }

  return 'pen-invalid-status';
};

export const validatePenSemantics = (
  artifact: PenRegressionArtifact,
  manifest: readonly PenAdapterDefinition[] = PEN_REGRESSION_MANIFEST,
): string | undefined => {
  if (artifact.checkId !== 'pen-regression') return 'pen-check-id';
  if (artifact.adapters.length !== manifest.length) return 'pen-adapter-set-size-mismatch';

  const seen = new Set<string>();
  for (const adapter of artifact.adapters) {
    if (seen.has(adapter.adapterId)) return 'pen-duplicate-adapter';
    seen.add(adapter.adapterId);
  }

  for (const definition of manifest) {
    if (!seen.has(definition.id)) return 'pen-missing-required-adapter';
  }

  for (const adapter of artifact.adapters) {
    const definition = manifest.find((item) => item.id === adapter.adapterId);
    if (!definition) return 'pen-unknown-adapter';
    const error = validatePenAdapterAgainstManifest(adapter, definition);
    if (error) return error;
  }

  const requiredResults = artifact.adapters.filter((adapter) => {
    const definition = manifest.find((item) => item.id === adapter.adapterId);
    return definition?.required !== false;
  });

  const anyUnavailable = requiredResults.some((adapter) => adapter.status === 'unavailable');
  const anyNotExecuted = requiredResults.some((adapter) => adapter.status === 'not-executed');
  const anyFailed = requiredResults.some((adapter) => adapter.status === 'failed');
  const allPassed = requiredResults.every((adapter) => adapter.status === 'passed');

  let expectedStatus: CheckStatus;
  let expectedReason: string | undefined;
  if (allPassed) {
    expectedStatus = 'passed';
  } else if (anyUnavailable) {
    expectedStatus = 'unavailable';
    expectedReason = 'adapter-unavailable';
  } else if (anyNotExecuted) {
    expectedStatus = 'failed';
    expectedReason = 'missing-required-adapter';
  } else if (anyFailed) {
    expectedStatus = 'failed';
    expectedReason = 'adapter-failed';
  } else {
    expectedStatus = 'failed';
    expectedReason = 'incomplete-coverage';
  }

  if (artifact.status !== expectedStatus) return 'pen-aggregate-status-mismatch';
  if (expectedStatus === 'passed') {
    if (artifact.reason !== undefined) return 'pen-passed-with-reason';
  } else if (artifact.reason !== expectedReason) {
    return 'pen-aggregate-reason-mismatch';
  }

  return undefined;
};

const omitUndefinedReason = (check: DerivedCheck): DerivedCheck => {
  if (check.reason === undefined) return { checkId: check.checkId, status: check.status };
  return check;
};

export const deriveChecksFromArtifacts = (input: {
  dependency: DependencyScanArtifact;
  leakage: LeakageScanArtifact;
  pen: PenRegressionArtifact;
  manifest?: readonly PenAdapterDefinition[];
}): { checks: DerivedCheck[]; overall: OverallStatus; semanticError?: string } => {
  const dependencyError = validateDependencySemantics(input.dependency);
  const leakageError = validateLeakageSemantics(input.leakage);
  const penError = validatePenSemantics(input.pen, input.manifest ?? PEN_REGRESSION_MANIFEST);
  const semanticError = dependencyError ?? leakageError ?? penError;

  if (semanticError) {
    return {
      checks: [
        omitUndefinedReason({
          checkId: 'dependency-scan',
          reason: dependencyError ?? input.dependency.reason,
          status: dependencyError ? 'unavailable' : input.dependency.status,
        }),
        omitUndefinedReason({
          checkId: 'leakage-scan',
          reason: leakageError ?? input.leakage.reason,
          status: leakageError ? 'unavailable' : input.leakage.status,
        }),
        omitUndefinedReason({
          checkId: 'pen-regression',
          reason: penError ?? input.pen.reason,
          status: penError ? 'unavailable' : input.pen.status,
        }),
      ],
      overall: 'unavailable',
      semanticError,
    };
  }

  const checks: DerivedCheck[] = [
    omitUndefinedReason({
      checkId: 'dependency-scan',
      reason: input.dependency.reason,
      status: input.dependency.status,
    }),
    omitUndefinedReason({
      checkId: 'leakage-scan',
      reason: input.leakage.reason,
      status: input.leakage.status,
    }),
    omitUndefinedReason({
      checkId: 'pen-regression',
      reason: input.pen.reason,
      status: input.pen.status,
    }),
  ];

  return {
    checks,
    overall: deriveOverall(checks.map((check) => check.status)),
  };
};

export { REQUIRED_PEN_ADAPTER_IDS };
