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
  const skipped = report.numPendingTests + report.numTodoTests;
  const countedTotal = report.numPassedTests + report.numFailedTests + skipped;

  if (countedTotal !== report.numTotalTests) {
    throw new Error(`${scenario.scenarioId}: Vitest assertion counts are inconsistent`);
  }

  if (report.numTotalTests !== reportDefinition.expectedAssertions) {
    throw new Error(
      `${scenario.scenarioId}: expected ${reportDefinition.expectedAssertions} assertions, received ${report.numTotalTests}`,
    );
  }

  const endTime = report.testResults.reduce(
    (latest, result) => Math.max(latest, result.endTime),
    report.startTime,
  );

  return {
    assertions: {
      failed: report.numFailedTests,
      passed: report.numPassedTests,
      skipped,
      total: report.numTotalTests,
    },
    elapsedMilliseconds: Math.max(0, endTime - report.startTime),
    reportSuccess: report.success,
  };
};

const writeEvidence = async (outputDirectory: string, evidence: FailureDrillEvidence) => {
  const outputPath = path.join(outputDirectory, `${evidence.scenarioId}.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8' });
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

  for (const scenario of FAILURE_DRILL_SCENARIOS) {
    const artifactHash = createHash('sha256');
    const reportResults = [];

    for (const reportDefinition of scenario.reports) {
      const reportPath = path.join(reportsDirectory, reportDefinition.reportFile);
      const reportBuffer = await readFile(reportPath);
      artifactHash.update(reportBuffer).update('\0');
      reportResults.push(parseReport(reportBuffer.toString('utf8'), scenario, reportDefinition));
    }

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
      artifact: { sha256: artifactHash.digest('hex') },
      assertions,
      cleanupResult,
      dependencies,
      elapsed: {
        milliseconds: reportResults.reduce(
          (total, report) => total + report.elapsedMilliseconds,
          0,
        ),
      },
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

  return { passed, records };
};

export const verifyFailureDrillEvidence = async (outputDirectory: string): Promise<boolean> => {
  const records = await Promise.all(
    FAILURE_DRILL_SCENARIOS.map(async ({ scenarioId }) => {
      const source = await readFile(path.join(outputDirectory, `${scenarioId}.json`), 'utf8');
      return failureDrillEvidenceSchema.parse(JSON.parse(source));
    }),
  );

  return records.every(isPassingFailureDrillEvidence);
};
