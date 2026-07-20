import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createUpstreamRebaseEvidence,
  isPassingUpstreamRebaseEvidence,
  UPSTREAM_REBASE_CI_LANE,
  UPSTREAM_REBASE_CI_SCHEMA_VERSION,
  type UpstreamRebaseEvidence,
} from './contract';
import {
  assertReportCommitsMatch,
  parseCommitsFileStrict,
  type ParsedCommitsFile,
  type ParsedGateResult,
  type ParsedRebaseReport,
  parseGateResultsStrict,
  parseRebaseReportStrict,
} from './schemas';
import { assertNoSecrets } from './secretScan';

const SHORT_HASH_LENGTH = 12;

const shortHash = (hash: string) => hash.slice(0, SHORT_HASH_LENGTH);

export interface CollectEvidenceOptions {
  cleanupResult: 'failed' | 'passed';
  fullCommits: ParsedCommitsFile;
  gateResults: ParsedGateResult[];
  outputDirectory: string;
  rawReportText: string;
  report: ParsedRebaseReport;
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
  rawReportText,
  report,
  upstreamFreshness,
  upstreamRef,
  upstreamRepository,
}: CollectEvidenceOptions): Promise<UpstreamRebaseEvidence> => {
  assertNoSecrets(rawReportText, 'raw rebase report');
  assertNoSecrets(report, 'parsed rebase report');

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

  assertReportCommitsMatch(report, fullCommits);

  const requiredGateIds = report.requiredGates
    .map((gate) => gate.id)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const sortedGateResults = parseGateResultsStrict(gateResults, requiredGateIds);

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

  assertNoSecrets(core, 'evidence core before redaction seal');
  const evidence = createUpstreamRebaseEvidence(core);
  assertNoSecrets(evidence, 'final evidence artifact');

  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertNoSecrets(serialized, 'serialized evidence artifact');
  await writeFile(evidencePath, serialized, 'utf8');

  const digest = createHash('sha256').update(serialized).digest('hex');
  await writeFile(path.join(outputDirectory, 'evidence.sha256'), `${digest}\n`, 'utf8');

  return evidence;
};

export const loadRebaseReport = async (
  reportPath: string,
): Promise<{ rawText: string; report: ParsedRebaseReport }> => {
  const rawText = await readFile(reportPath, 'utf8');
  assertNoSecrets(rawText, 'raw rebase report file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Rebase report is malformed JSON');
  }
  const report = parseRebaseReportStrict(parsed);
  return { rawText, report };
};

export const loadCommitsFile = async (commitsPath: string): Promise<ParsedCommitsFile> => {
  const raw = await readFile(commitsPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Commits file is malformed JSON');
  }
  return parseCommitsFileStrict(parsed);
};

export const loadGateResultsFile = async (
  gatesPath: string,
  requiredGateIds: string[],
): Promise<ParsedGateResult[]> => {
  const raw = await readFile(gatesPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Gate results file is malformed JSON');
  }
  return parseGateResultsStrict(parsed, requiredGateIds);
};

export const assertEvidencePassing = (evidence: UpstreamRebaseEvidence) => {
  if (!isPassingUpstreamRebaseEvidence(evidence)) {
    throw new Error('Upstream rebase dry-run evidence is not passing');
  }
};
