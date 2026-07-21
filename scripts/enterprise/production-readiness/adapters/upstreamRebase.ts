/**
 * Q05 upstream-rebase adapter: mandatory candidate binding; immutable generatedAt required.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  isPassingUpstreamRebaseEvidence,
  upstreamRebaseEvidenceSchema,
} from '../../upstream-rebase-ci/contract';
import type { AdaptedGateEvidence } from './types';

export const adaptUpstreamRebaseEvidence = async (input: {
  candidateSha: string;
  evidencePath: string;
}): Promise<AdaptedGateEvidence> => {
  const raw = await readFile(input.evidencePath, 'utf8');
  const artifactSha256 = createHash('sha256').update(raw).digest('hex');
  const evidence = upstreamRebaseEvidenceSchema.parse(JSON.parse(raw));

  const short = input.candidateSha.slice(0, 12);
  if (evidence.commits.candidate !== short) {
    throw new Error('upstream-rebase candidate short does not match release candidate');
  }

  const record = JSON.parse(raw) as { generatedAt?: string };
  if (typeof record.generatedAt !== 'string' || Number.isNaN(Date.parse(record.generatedAt))) {
    return {
      artifactSha256,
      assertions: {
        failed: evidence.gates.filter((g) => g.outcome === 'failed').length,
        passed: evidence.gates.filter((g) => g.outcome === 'passed').length,
        skipped: 0,
        total: evidence.gates.length,
      },
      candidateSha: input.candidateSha,
      details: { reason: 'missing-immutable-generatedAt' },
      gate: 'upstream-rebase',
      generatedAt: new Date(0).toISOString(),
      harnessScope: 'ci-harness',
      rawArtifactPaths: [input.evidencePath],
      status: 'unverified',
    };
  }

  const pass = isPassingUpstreamRebaseEvidence(evidence);
  const status = pass
    ? ('passed' as const)
    : evidence.cleanupResult === 'failed'
      ? ('failed' as const)
      : ('unverified' as const);

  return {
    artifactSha256,
    assertions: {
      failed: evidence.gates.filter((g) => g.outcome === 'failed').length,
      passed: evidence.gates.filter((g) => g.outcome === 'passed').length,
      skipped: 0,
      total: evidence.gates.length,
    },
    candidateSha: input.candidateSha,
    details: {
      cleanupResult: evidence.cleanupResult,
      reportStatus: evidence.reportStatus,
      requiredGateCount: evidence.requiredGateIds.length,
      upstreamFreshness: evidence.upstream.freshness,
    },
    gate: 'upstream-rebase',
    generatedAt: record.generatedAt,
    harnessScope: 'ci-harness',
    rawArtifactPaths: [input.evidencePath],
    status,
  };
};
