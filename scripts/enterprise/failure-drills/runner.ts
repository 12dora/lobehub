import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { FailureDrillDependencies, FailureDrillEvidence } from './contract';
import {
  createFailureDrillEvidence,
  FAILURE_DRILL_LANE,
  FAILURE_DRILL_SCHEMA_VERSION,
  failureDrillEvidenceSchema,
  isPassingFailureDrillEvidence,
} from './contract';
import type { FailureDrillReport, FailureDrillScenario } from './scenarios';
import { FAILURE_DRILL_SCENARIOS } from './scenarios';

const vitestReportSchema = z
  .object({
    numFailedTests: z.number().int().nonnegative(),
    numPassedTests: z.number().int().nonnegative(),
    numPendingTests: z.number().int().nonnegative(),
    numTodoTests: z.number().int().nonnegative(),
    numTotalTests: z.number().int().nonnegative(),
    startTime: z.number().finite().nonnegative(),
    success: z.boolean(),
    testResults: z.array(
      z.object({
        assertionResults: z.array(
          z.object({
            status: z.enum(['failed', 'passed', 'pending', 'skipped', 'todo']),
            title: z.string(),
          }),
        ),
        endTime: z.number().finite().nonnegative(),
      }),
    ),
  })
  .passthrough();

interface CollectFailureDrillEvidenceOptions {
  cleanupResult: 'failed' | 'passed';
  dependencies: FailureDrillDependencies;
  gitSha: string;
  outputDirectory: string;
  reportsDirectory: string;
}

export interface CollectFailureDrillEvidenceResult {
  passed: boolean;
  records: FailureDrillEvidence[];
}

const parseReport = (
  source: string,
  scenario: FailureDrillScenario,
  reportDefinition: FailureDrillReport,
) => {
  const report = vitestReportSchema.parse(JSON.parse(source));
  const selectedAssertions = reportDefinition.assertionTitles
    ? report.testResults
        .flatMap(({ assertionResults }) => assertionResults)
        .filter(({ title }) => reportDefinition.assertionTitles?.includes(title))
    : undefined;
  const passed = selectedAssertions
    ? selectedAssertions.filter(({ status }) => status === 'passed').length
    : report.numPassedTests;
  const failed = selectedAssertions
    ? selectedAssertions.filter(({ status }) => status === 'failed').length
    : report.numFailedTests;
  const skipped = selectedAssertions
    ? selectedAssertions.filter(
        ({ status }) => status === 'pending' || status === 'skipped' || status === 'todo',
      ).length
    : report.numPendingTests + report.numTodoTests;
  const total = selectedAssertions?.length ?? report.numTotalTests;
  const countedTotal = passed + failed + skipped;

  if (countedTotal !== total) {
    throw new Error(`${scenario.scenarioId}: Vitest assertion counts are inconsistent`);
  }

  if (total !== reportDefinition.expectedAssertions) {
    throw new Error(
      `${scenario.scenarioId}: expected ${reportDefinition.expectedAssertions} assertions, received ${total}`,
    );
  }

  const endTime = report.testResults.reduce(
    (latest, result) => Math.max(latest, result.endTime),
    report.startTime,
  );

  return {
    assertions: {
      failed,
      passed,
      skipped,
      total,
    },
    elapsedMilliseconds: Math.max(0, endTime - report.startTime),
    reportSuccess: report.success && failed === 0,
  };
};

const writeEvidence = async (outputDirectory: string, evidence: FailureDrillEvidence) => {
  const outputPath = path.join(outputDirectory, `${evidence.scenarioId}.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8' });
};

/** Deterministic aggregate digest of ordered raw Vitest report files (null-separated). */
export const digestFailureDrillRawReports = async (
  reportsDirectory: string,
  reportFiles: readonly string[],
): Promise<string> => {
  const artifactHash = createHash('sha256');
  for (const reportFile of reportFiles) {
    const reportBuffer = await readFile(path.join(reportsDirectory, reportFile));
    artifactHash.update(reportBuffer).update('\0');
  }
  return artifactHash.digest('hex');
};

export const collectFailureDrillEvidence = async ({
  cleanupResult,
  dependencies,
  gitSha,
  outputDirectory,
  reportsDirectory,
}: CollectFailureDrillEvidenceOptions): Promise<CollectFailureDrillEvidenceResult> => {
  await mkdir(outputDirectory, { recursive: true });

  const records: FailureDrillEvidence[] = [];
  let passed = cleanupResult === 'passed';
  const manifestReports: Array<{ reportFile: string; sha256: string }> = [];

  for (const scenario of FAILURE_DRILL_SCENARIOS) {
    const reportResults = [];
    const reportFiles = scenario.reports.map((report) => report.reportFile);

    for (const reportDefinition of scenario.reports) {
      const reportPath = path.join(reportsDirectory, reportDefinition.reportFile);
      const reportBuffer = await readFile(reportPath);
      const reportSha = createHash('sha256').update(reportBuffer).digest('hex');
      manifestReports.push({ reportFile: reportDefinition.reportFile, sha256: reportSha });
      reportResults.push(parseReport(reportBuffer.toString('utf8'), scenario, reportDefinition));
    }

    const artifactSha256 = await digestFailureDrillRawReports(reportsDirectory, reportFiles);

    const assertions = reportResults.reduce(
      (summary, report) => ({
        failed: summary.failed + report.assertions.failed,
        passed: summary.passed + report.assertions.passed,
        skipped: summary.skipped + report.assertions.skipped,
        total: summary.total + report.assertions.total,
      }),
      { failed: 0, passed: 0, skipped: 0, total: 0 },
    );
    const evidence = createFailureDrillEvidence({
      artifact: { sha256: artifactSha256 },
      assertions,
      cleanupResult,
      dependencies,
      elapsed: {
        milliseconds: reportResults.reduce(
          (total, report) => total + report.elapsedMilliseconds,
          0,
        ),
      },
      generatedAt: new Date().toISOString(),
      gitSha,
      injection: scenario.injection,
      lane: FAILURE_DRILL_LANE,
      recovery: scenario.recovery,
      scenarioId: scenario.scenarioId,
      schemaVersion: FAILURE_DRILL_SCHEMA_VERSION,
    });

    await writeEvidence(outputDirectory, evidence);
    records.push(evidence);
    passed &&=
      reportResults.every(({ reportSuccess }) => reportSuccess) &&
      isPassingFailureDrillEvidence(evidence);
  }

  // Bind candidate SHA + exact per-file raw-report digests for later re-verification.
  const manifest = {
    gitSha,
    reports: manifestReports,
    schemaVersion: 1 as const,
  };
  await writeFile(
    path.join(outputDirectory, 'raw-report-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  return { passed, records };
};

export interface VerifyFailureDrillEvidenceOptions {
  /**
   * Directory of raw Vitest JSON reports. Required to recompute artifact digests.
   * When omitted, verification fails closed (forged aggregate-only evidence rejected).
   */
  reportsDirectory?: string;
}

/**
 * Verify multi-scenario evidence and re-bind each artifact.sha256 to raw report bytes.
 * Aggregate JSON alone (forged hashes) is never accepted without matching raw reports.
 */
export const verifyFailureDrillEvidence = async (
  outputDirectory: string,
  options: VerifyFailureDrillEvidenceOptions = {},
): Promise<boolean> => {
  const reportsDirectory = options.reportsDirectory;
  if (!reportsDirectory) {
    // Without raw reports, digests cannot be recomputed — reject aggregate-only evidence.
    return false;
  }

  const records = await Promise.all(
    FAILURE_DRILL_SCENARIOS.map(async (scenario) => {
      const source = await readFile(
        path.join(outputDirectory, `${scenario.scenarioId}.json`),
        'utf8',
      );
      const evidence = failureDrillEvidenceSchema.parse(JSON.parse(source));
      const reportFiles = scenario.reports.map((report) => report.reportFile);
      let recomputed: string;
      try {
        recomputed = await digestFailureDrillRawReports(reportsDirectory, reportFiles);
      } catch {
        return null;
      }
      if (recomputed !== evidence.artifact.sha256) return null;
      return evidence;
    }),
  );

  if (records.includes(null)) return false;
  return records.every((record) => record !== null && isPassingFailureDrillEvidence(record));
};
