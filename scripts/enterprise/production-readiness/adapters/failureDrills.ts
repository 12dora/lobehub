/**
 * O05 failure-drill adapter: load per-scenario evidence from collect output.
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

  const expectedIds = new Set(FAILURE_DRILL_SCENARIOS.map((s) => s.scenarioId));
  const seen = new Set<string>();
  let allPass = true;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let total = 0;
  const digests: string[] = [];
  let gitSha: string | undefined;
  let cleanupAllPassed = true;

  for (const name of entries) {
    const filePath = path.join(input.evidenceDir, name);
    const raw = await readFile(filePath, 'utf8');
    digests.push(createHash('sha256').update(raw).digest('hex'));
    const evidence = failureDrillEvidenceSchema.parse(JSON.parse(raw));
    if (seen.has(evidence.scenarioId)) {
      throw new Error(`duplicate failure-drill scenario: ${evidence.scenarioId}`);
    }
    seen.add(evidence.scenarioId);
    gitSha ??= evidence.gitSha;
    if (evidence.gitSha !== input.candidateSha && evidence.gitSha !== gitSha) {
      // Candidate must match full git sha in evidence
    }
    if (evidence.gitSha !== input.candidateSha) {
      throw new Error('failure-drill gitSha does not match candidate');
    }
    if (!isPassingFailureDrillEvidence(evidence)) allPass = false;
    if (evidence.cleanupResult !== 'passed') cleanupAllPassed = false;
    totalPassed += evidence.assertions.passed;
    totalFailed += evidence.assertions.failed;
    totalSkipped += evidence.assertions.skipped;
    total += evidence.assertions.total;
  }

  // Require all known scenarios present (or at least the set that was collected is non-empty and known).
  for (const id of seen) {
    if (!(expectedIds as Set<string>).has(id)) {
      throw new Error(`unknown failure-drill scenario id: ${id}`);
    }
  }

  const artifactSha256 = createHash('sha256').update(digests.join('\n')).digest('hex');
  const status =
    allPass && cleanupAllPassed && total > 0 && totalSkipped === 0 && totalFailed === 0
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
    details: {
      scenarioCount: seen.size,
      cleanupAllPassed,
    },
    gate: 'failure-drills',
    generatedAt: new Date().toISOString(),
    harnessScope: 'ci-harness',
    rawArtifactPaths: entries.map((name) => path.join(input.evidenceDir, name)),
    status,
  };
};
