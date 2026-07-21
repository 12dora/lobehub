/**
 * Q05 adapter against actual upstreamRebaseEvidenceSchema.
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

  if (evidence.candidateSha) {
    if (evidence.candidateSha !== input.candidateSha) {
      throw new Error('upstream-rebase candidateSha mismatch');
    }
  } else if (evidence.commits.candidate !== input.candidateSha.slice(0, 12)) {
    throw new Error('upstream-rebase candidate short does not match release candidate');
  }

  if (!evidence.generatedAt) {
    return {
      artifactSha256,
      assertions: {
        failed: evidence.gates.filter((g) => g.outcome === 'failed').length,
        passed: evidence.gates.filter((g) => g.outcome === 'passed').length,
        skipped: 0,
        total: evidence.gates.length,
      },
      candidateSha: input.candidateSha,
      details: { reason: 'missing-generatedAt' },
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
    generatedAt: evidence.generatedAt,
    harnessScope: 'ci-harness',
    rawArtifactPaths: [input.evidencePath],
    status,
  };
};
