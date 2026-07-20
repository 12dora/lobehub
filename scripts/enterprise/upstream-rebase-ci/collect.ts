import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RebaseReport } from '../rebase-report';
import {
  createUpstreamRebaseEvidence,
  type GateResult,
  isPassingUpstreamRebaseEvidence,
  UPSTREAM_REBASE_CI_LANE,
  UPSTREAM_REBASE_CI_SCHEMA_VERSION,
  type UpstreamRebaseEvidence,
} from './contract';

const SHORT_HASH_LENGTH = 12;
const FULL_HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;

const shortHash = (hash: string) => {
  if (!FULL_HASH_PATTERN.test(hash) && !/^[a-f\d]{12}$/u.test(hash)) {
    throw new Error('Commit hash is invalid');
  }
  return hash.slice(0, SHORT_HASH_LENGTH);
};

export interface CollectEvidenceOptions {
  cleanupResult: 'failed' | 'passed';
  fullCommits: {
    base: string;
    candidate: string;
    mergeBase: string;
    upstream: string;
  };
  gateResults: GateResult[];
  outputDirectory: string;
  report: RebaseReport;
  upstreamFreshness: 'unverified' | 'verified-by-ci-fetch';
  upstreamRef: string;
  upstreamRepository: string;
}

/**
 * Build a redacted evidence document from the rebase report + CI gate outcomes.
 * Rejects non-clean reports, unverified freshness, missing gates, and secretful content.
 */
export const collectUpstreamRebaseEvidence = async ({
  cleanupResult,
  fullCommits,
  gateResults,
  outputDirectory,
  report,
  upstreamFreshness,
  upstreamRef,
  upstreamRepository,
}: CollectEvidenceOptions): Promise<UpstreamRebaseEvidence> => {
  if (report.schemaVersion !== 1) {
    throw new Error('Rebase report schemaVersion is unsupported');
  }

  if (report.status !== 'clean') {
    throw new Error(`Rebase report status is ${report.status}; dry-run fails closed`);
  }

  if (report.conflicts.length > 0 || report.summary.conflicts > 0) {
    throw new Error('Rebase report lists conflicts; dry-run fails closed');
  }

  if (report.patchDrift.length > 0 || report.summary.patchDrift > 0) {
    throw new Error('Rebase report lists patch drift; dry-run fails closed');
  }

  if (upstreamFreshness !== 'verified-by-ci-fetch') {
    throw new Error('Upstream freshness is unverified; dry-run fails closed');
  }

  if (!report.requiredGates || report.requiredGates.length === 0) {
    throw new Error('Rebase report is missing required gates');
  }

  const requiredGateIds = report.requiredGates
    .map((gate) => gate.id)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const sortedGateResults = [...gateResults].sort((left, right) =>
    left.id.localeCompare(right.id, 'en'),
  );

  if (sortedGateResults.length !== requiredGateIds.length) {
    throw new Error('Gate result count does not match required gates');
  }

  for (const id of requiredGateIds) {
    if (!sortedGateResults.some((gate) => gate.id === id)) {
      throw new Error(`Missing gate result for required gate ${id}`);
    }
  }

  // Evidence never retains path lists, conflict bodies, or full commit messages —
  // only short SHAs, counts, gate outcomes, and classification fields.
  const core = {
    analysis: {
      mode: 'dry-run-evidence' as const,
      networkAccess: 'ci-fetch-only' as const,
      productionRebase: false as const,
      push: false as const,
      worktreeMutation: 'isolated-temp-only' as const,
    },
    cleanupResult,
    commits: {
      base: shortHash(fullCommits.base),
      candidate: shortHash(fullCommits.candidate),
      mergeBase: shortHash(fullCommits.mergeBase),
      upstream: shortHash(fullCommits.upstream),
    },
    gates: sortedGateResults.map((gate) => ({
      assertions: gate.assertions,
      id: gate.id,
      kind: gate.kind,
      outcome: gate.outcome,
      reason: gate.reason,
    })),
    lane: UPSTREAM_REBASE_CI_LANE,
    reportStatus: report.status,
    requiredGateIds,
    schemaVersion: UPSTREAM_REBASE_CI_SCHEMA_VERSION,
    summary: {
      candidateChangedPaths: report.summary.candidateChangedPaths,
      conflicts: report.summary.conflicts,
      directModificationHotspots: report.summary.directModificationHotspots,
      patchDrift: report.summary.patchDrift,
      upstreamChangedPaths: report.summary.upstreamChangedPaths,
    },
    upstream: {
      freshness: upstreamFreshness,
      ref: upstreamRef,
      repository: upstreamRepository,
      sha: fullCommits.upstream.toLowerCase(),
    },
  };

  const evidence = createUpstreamRebaseEvidence(core);

  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, serialized, 'utf8');

  const digest = createHash('sha256').update(serialized).digest('hex');
  await writeFile(path.join(outputDirectory, 'evidence.sha256'), `${digest}\n`, 'utf8');

  return evidence;
};

export const loadRebaseReport = async (reportPath: string): Promise<RebaseReport> => {
  const raw = await readFile(reportPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Rebase report is malformed JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Rebase report must be an object');
  }

  const report = parsed as RebaseReport;
  if (report.schemaVersion !== 1) {
    throw new Error('Rebase report schemaVersion is unsupported');
  }
  if (!report.status || !report.summary || !report.commits || !report.requiredGates) {
    throw new Error('Rebase report is missing required fields');
  }

  return report;
};

export const assertEvidencePassing = (evidence: UpstreamRebaseEvidence) => {
  if (!isPassingUpstreamRebaseEvidence(evidence)) {
    throw new Error('Upstream rebase dry-run evidence is not passing');
  }
};
