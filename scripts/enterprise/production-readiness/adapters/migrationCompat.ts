/**
 * Q03 migration-compat adapter: mandatory candidate binding; immutable generatedAt required.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { gatePassed, migrationCompatReportSchema } from '../../verify-migration/contract';
import type { AdaptedGateEvidence } from './types';

export const adaptMigrationCompatReport = async (input: {
  candidateSha: string;
  reportPath: string;
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
  // Mandatory candidate binding: head short must be unambiguous prefix of full candidate SHA.
  if (!input.candidateSha.startsWith(report.head.commitShort)) {
    throw new Error('migration-compat head commit does not match candidate');
  }

  const foundationOk = gatePassed(report);
  const record = parsed as { generatedAt?: string };
  if (typeof record.generatedAt !== 'string' || Number.isNaN(Date.parse(record.generatedAt))) {
    // Source format lacks immutable timestamp → unverified until collector upgraded.
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
        reason: 'missing-immutable-generatedAt',
      },
      gate: 'migration-compat',
      generatedAt: new Date(0).toISOString(),
      harnessScope: 'local-harness',
      rawArtifactPaths: [input.reportPath],
      status: 'unverified',
    };
  }

  const status = foundationOk
    ? ('passed' as const)
    : report.overall === 'failed' || report.rerun.result === 'skipped'
      ? ('failed' as const)
      : ('unverified' as const);

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
    generatedAt: record.generatedAt,
    harnessScope: 'local-harness',
    rawArtifactPaths: [input.reportPath],
    status,
  };
};
