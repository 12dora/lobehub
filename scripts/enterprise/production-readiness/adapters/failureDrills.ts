/**
 * O05 adapter: exact four scenarios; uses generatedAt from producer when present.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  failureDrillEvidenceSchema,
  isPassingFailureDrillEvidence,
} from '../../failure-drills/contract';
import { FAILURE_DRILL_SCENARIOS } from '../../failure-drills/scenarios';
import type { AdaptedGateEvidence } from './types';

const EXPECTED_SCENARIO_IDS = FAILURE_DRILL_SCENARIOS.map((s) => s.scenarioId).sort((a, b) =>
  a.localeCompare(b, 'en'),
);

export const adaptFailureDrillEvidenceDir = async (input: {
  candidateSha: string;
  evidenceDir: string;
}): Promise<AdaptedGateEvidence> => {
  const entries = (await readdir(input.evidenceDir))
    .filter((name) => name.endsWith('.json') && name !== 'summary.json')
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (entries.length === 0) {
    throw new Error('failure-drills evidence directory has no scenario JSON files');
  }

  const seen = new Set<string>();
  let allPass = true;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let total = 0;
  const digests: string[] = [];
  let earliestGeneratedMs = Number.POSITIVE_INFINITY;

  for (const name of entries) {
    const filePath = path.join(input.evidenceDir, name);
    const raw = await readFile(filePath, 'utf8');
    digests.push(createHash('sha256').update(raw).digest('hex'));
    const evidence = failureDrillEvidenceSchema.parse(JSON.parse(raw));
    if (seen.has(evidence.scenarioId)) {
      throw new Error(`duplicate failure-drill scenario: ${evidence.scenarioId}`);
    }
    seen.add(evidence.scenarioId);
    if (evidence.gitSha !== input.candidateSha) {
      throw new Error('failure-drill gitSha does not match candidate');
    }
    if (evidence.generatedAt) {
      const ms = Date.parse(evidence.generatedAt);
      if (!Number.isNaN(ms)) earliestGeneratedMs = Math.min(earliestGeneratedMs, ms);
    }
    if (!isPassingFailureDrillEvidence(evidence) || evidence.cleanupResult !== 'passed') {
      allPass = false;
    }
    totalPassed += evidence.assertions.passed;
    totalFailed += evidence.assertions.failed;
    totalSkipped += evidence.assertions.skipped;
    total += evidence.assertions.total;
  }

  const seenSorted = [...seen].sort((a, b) => a.localeCompare(b, 'en'));
  if (
    seenSorted.length !== EXPECTED_SCENARIO_IDS.length ||
    seenSorted.some((id, i) => id !== EXPECTED_SCENARIO_IDS[i])
  ) {
    throw new Error(
      `failure-drills scenarios incomplete: expected [${EXPECTED_SCENARIO_IDS.join(',')}] got [${seenSorted.join(',')}]`,
    );
  }

  const artifactSha256 = createHash('sha256').update(digests.join('\n')).digest('hex');
  if (!Number.isFinite(earliestGeneratedMs)) {
    return {
      artifactSha256,
      assertions: { failed: totalFailed, passed: totalPassed, skipped: totalSkipped, total },
      candidateSha: input.candidateSha,
      details: { scenarioCount: seen.size, reason: 'missing-generatedAt' },
      gate: 'failure-drills',
      generatedAt: new Date(0).toISOString(),
      harnessScope: 'ci-harness',
      rawArtifactPaths: entries.map((n) => path.join(input.evidenceDir, n)),
      status: 'unverified',
    };
  }

  const status =
    allPass && total > 0 && totalSkipped === 0 && totalFailed === 0
      ? ('passed' as const)
      : totalFailed > 0
        ? ('failed' as const)
        : ('unverified' as const);

  return {
    artifactSha256,
    assertions: {
      failed: totalFailed,
      passed: totalPassed,
      skipped: totalSkipped,
      total,
    },
    candidateSha: input.candidateSha,
    details: { scenarioCount: seen.size },
    gate: 'failure-drills',
    generatedAt: new Date(earliestGeneratedMs).toISOString(),
    harnessScope: 'ci-harness',
    rawArtifactPaths: entries.map((n) => path.join(input.evidenceDir, n)),
    status,
  };
};
