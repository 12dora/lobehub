/**
 * O05 adapter: exact four scenarios; every scenario must carry its own generatedAt.
 * Mixed/missing timestamps fail closed — never borrow freshness from siblings.
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

const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const adaptFailureDrillEvidenceDir = async (input: {
  candidateSha: string;
  clockSkewMs?: number;
  evidenceDir: string;
  maxAgeMs?: number;
  nowMs?: number;
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
  const generatedMsList: number[] = [];
  let missingGeneratedAt = false;
  let invalidGeneratedAt = false;
  let futureGeneratedAt = false;
  let staleGeneratedAt = false;

  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const clockSkewMs = input.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

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

    // Every scenario must carry its own immutable generatedAt (no borrowing).
    if (!evidence.generatedAt) {
      missingGeneratedAt = true;
    } else {
      const ms = Date.parse(evidence.generatedAt);
      if (Number.isNaN(ms)) {
        invalidGeneratedAt = true;
      } else {
        generatedMsList.push(ms);
        const ageMs = nowMs - ms;
        if (ageMs < -clockSkewMs) futureGeneratedAt = true;
        if (ageMs > maxAgeMs + clockSkewMs) staleGeneratedAt = true;
      }
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
  const paths = entries.map((n) => path.join(input.evidenceDir, n));

  // Fail closed if any scenario lacks a valid timestamp, or set is incomplete.
  if (
    missingGeneratedAt ||
    invalidGeneratedAt ||
    generatedMsList.length !== EXPECTED_SCENARIO_IDS.length
  ) {
    return {
      artifactSha256,
      assertions: { failed: totalFailed, passed: totalPassed, skipped: totalSkipped, total },
      candidateSha: input.candidateSha,
      details: {
        reason: missingGeneratedAt
          ? 'missing-generatedAt'
          : invalidGeneratedAt
            ? 'invalid-generatedAt'
            : 'incomplete-generatedAt-set',
        scenarioCount: seen.size,
      },
      gate: 'failure-drills',
      generatedAt: new Date(0).toISOString(),
      harnessScope: 'ci-harness',
      rawArtifactPaths: paths,
      status: 'unverified',
    };
  }

  if (futureGeneratedAt) {
    return {
      artifactSha256,
      assertions: { failed: totalFailed, passed: totalPassed, skipped: totalSkipped, total },
      candidateSha: input.candidateSha,
      details: { reason: 'future-generatedAt', scenarioCount: seen.size },
      gate: 'failure-drills',
      generatedAt: new Date(Math.min(...generatedMsList)).toISOString(),
      harnessScope: 'ci-harness',
      rawArtifactPaths: paths,
      status: 'failed',
    };
  }

  if (staleGeneratedAt) {
    return {
      artifactSha256,
      assertions: { failed: totalFailed, passed: totalPassed, skipped: totalSkipped, total },
      candidateSha: input.candidateSha,
      details: { reason: 'stale-generatedAt', scenarioCount: seen.size },
      gate: 'failure-drills',
      generatedAt: new Date(Math.min(...generatedMsList)).toISOString(),
      harnessScope: 'ci-harness',
      rawArtifactPaths: paths,
      status: 'failed',
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
    // Aggregate freshness uses oldest of all four (conservative age).
    generatedAt: new Date(Math.min(...generatedMsList)).toISOString(),
    harnessScope: 'ci-harness',
    rawArtifactPaths: paths,
    status,
  };
};
