/**
 * Pure helpers modeling GitHub Actions shell semantics for security-acceptance jobs.
 * Used by unit tests to falsify set -e abort before evidence upload.
 */

export interface AcceptanceRunShellResult {
  /** Exit code from the harness process (0/1/2). */
  harnessExit: number;
  /** Always set when the run step starts (even if harness fails). */
  outputDir: string;
  /** True when a report file path is present for verify/upload. */
  reportPresent: boolean;
}

/**
 * Model the evidence job run step with controlled fail-open capture.
 * Unlike `set -e` without capture, harness nonzero does not prevent OUTPUT_DIR export.
 */
export const captureAcceptanceRun = (input: {
  harnessExit: number;
  outputDir: string;
  reportWritten: boolean;
}): AcceptanceRunShellResult => ({
  harnessExit: input.harnessExit,
  outputDir: input.outputDir,
  reportPresent: input.reportWritten,
});

/**
 * Final gate after verify + secret-scan + upload always attempted.
 * Missing report → fail. Otherwise propagate harness exit (or verify failure).
 */
export const finalAcceptanceGate = (input: {
  harnessExit: number;
  reportPresent: boolean;
  secretScanFailed: boolean;
  verifyFailed: boolean;
}): { exitCode: number; reason: string } => {
  if (!input.reportPresent) {
    return { exitCode: 2, reason: 'missing-report' };
  }
  if (input.verifyFailed) {
    return { exitCode: 1, reason: 'verify-failed' };
  }
  if (input.secretScanFailed) {
    return { exitCode: 1, reason: 'secret-scan-failed' };
  }
  if (input.harnessExit === 0) {
    return { exitCode: 0, reason: 'passed' };
  }
  return {
    exitCode: input.harnessExit === 2 ? 2 : 1,
    reason: input.harnessExit === 2 ? 'unavailable' : 'failed',
  };
};
