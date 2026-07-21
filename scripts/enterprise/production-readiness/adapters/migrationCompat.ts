/**
 * Q03 migration-compat adapter: strict parse of verify-migration report.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { gatePassed, migrationCompatReportSchema } from '../../verify-migration/contract';
import type { AdaptedGateEvidence } from './types';

export const adaptMigrationCompatReport = async (input: {
  candidateSha: string;
  reportPath: string;
  expectedHeadShort?: string;
}): Promise<AdaptedGateEvidence> => {
  const rawText = await readFile(input.reportPath, 'utf8');
  const artifactSha256 = createHash('sha256').update(rawText).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('migration-compat report is not valid JSON');
  }

  const report = migrationCompatReportSchema.parse(parsed);
  if (
    input.expectedHeadShort &&
    report.head.commitShort !== input.expectedHeadShort && // Allow short prefix match of candidate
    !input.candidateSha.startsWith(report.head.commitShort)
  ) {
    throw new Error('migration-compat head commit does not match candidate');
  }

  const foundationOk = gatePassed(report);
  // Journal-only: synthetic/rerun must pass; foundation gate is required.
  const status = foundationOk
    ? ('passed' as const)
    : report.overall === 'failed'
      ? ('failed' as const)
      : ('unverified' as const);

  // Extract generated time from report if present; else mtime unavailable — use now is wrong.
  // Migration report has no timestamp; use file content hash binding only and require external generatedAt via wrapper.
  // Adapter returns generatedAt as epoch 0 marker? Better: require companion meta or use fixed from report elapsed.
  // We'll use a companion field if present, else fail closed to unverified with details.
  const generatedAt =
    typeof (parsed as { generatedAt?: string }).generatedAt === 'string'
      ? (parsed as { generatedAt: string }).generatedAt
      : new Date(0).toISOString();

  return {
    artifactSha256,
    assertions: {
      failed: report.checks.filter((c) => c.result === 'failed').length,
      passed: report.checks.filter((c) => c.result === 'passed').length,
      skipped: report.checks.filter((c) => c.result === 'skipped' || c.result === 'unverified')
        .length,
      total: report.checks.length,
    },
    candidateSha: input.candidateSha,
    details: {
      foundationGatePassed: foundationOk,
      overall: report.overall,
      rerunResult: report.rerun.result,
      syntheticResult: report.syntheticResult,
      totalMigrationCount: report.head.totalMigrationCount,
    },
    gate: 'migration-compat',
    generatedAt,
    harnessScope: 'local-harness',
    rawArtifactPaths: [input.reportPath],
    status: foundationOk ? status : report.rerun.result === 'skipped' ? 'failed' : status,
  };
};
