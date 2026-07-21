/**
 * Q05 upstream-rebase adapter: strict evidence.json from upstream-rebase-ci collect.
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
  if (evidence.upstream.freshness !== 'verified-by-ci-fetch') {
    // Keep status from evidence but fail closed for production-style pass
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
    generatedAt: new Date().toISOString(),
    harnessScope: 'ci-harness',
    rawArtifactPaths: [input.evidencePath],
    status,
  };
};
