#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { analyzeRebase, formatRebaseReport } from '../rebase-report';
import { assertEvidencePassing, collectUpstreamRebaseEvidence, loadRebaseReport } from './collect';
import { prepareIsolatedAnalysisRepository, removeDirectoryExact } from './fetchUpstream';
import { runSelectedGates, writeGateResults } from './gates';
import { validateUpstreamInputs } from './validateInputs';

type Command = 'collect' | 'fetch' | 'run-gates' | 'validate-inputs';

const usage = `Usage:
  bun scripts/enterprise/upstream-rebase-ci/index.ts validate-inputs --repository <owner/name> --ref <ref>
  bun scripts/enterprise/upstream-rebase-ci/index.ts fetch --candidate-repo <path> --temp-dir <path> --repository <owner/name> --ref <ref> [--candidate-ref <ref>] --output <json>
  bun scripts/enterprise/upstream-rebase-ci/index.ts run-gates --repo <path> --report <json> --raw-dir <path> --output <json>
  bun scripts/enterprise/upstream-rebase-ci/index.ts collect --report <json> --gates <json> --commits <json> --cleanup-result <passed|failed> --upstream-repository <owner/name> --upstream-ref <ref> --upstream-freshness <verified-by-ci-fetch|unverified> --output-dir <path>
`;

const requireString = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
};

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const runValidateInputs = async (values: Record<string, string | boolean | undefined>) => {
  const validated = validateUpstreamInputs({
    ref: typeof values.ref === 'string' ? values.ref : undefined,
    repository: typeof values.repository === 'string' ? values.repository : undefined,
  });
  // Never print the fetch URL to GITHUB_OUTPUT in a way that gets uploaded.
  // Workflow may use repository+ref only; fetch URL is rebuilt inside fetch.
  process.stdout.write(
    `${JSON.stringify({ ref: validated.ref, repository: validated.repository })}\n`,
  );
};

const runFetch = async (values: Record<string, string | boolean | undefined>) => {
  const candidateRepository = path.resolve(
    requireString(values['candidate-repo'] as string | undefined, 'candidate-repo'),
  );
  const temporaryDirectory = path.resolve(
    requireString(values['temp-dir'] as string | undefined, 'temp-dir'),
  );
  const output = path.resolve(requireString(values.output as string | undefined, 'output'));
  const upstream = validateUpstreamInputs({
    ref: typeof values.ref === 'string' ? values.ref : undefined,
    repository: typeof values.repository === 'string' ? values.repository : undefined,
  });
  const candidateRef =
    typeof values['candidate-ref'] === 'string' && values['candidate-ref'].length > 0
      ? values['candidate-ref']
      : undefined;

  const resolved = await prepareIsolatedAnalysisRepository({
    candidateRef,
    candidateRepository,
    temporaryDirectory,
    upstream,
  });

  // Run the reviewed rebase-report against the isolated analysis repository only.
  const report = await analyzeRebase({
    baseRef: resolved.base,
    candidateRef: resolved.candidate,
    repositoryRoot: resolved.analysisRepository,
    temporaryDirectoryRoot: temporaryDirectory,
    upstreamRef: resolved.upstream,
  });

  const reportPath = path.join(temporaryDirectory, 'rebase-report.json');
  await writeFile(reportPath, formatRebaseReport(report, 'json'), 'utf8');

  await writeJson(output, {
    analysisRepository: resolved.analysisRepository,
    base: resolved.base,
    candidate: resolved.candidate,
    mergeBase: resolved.mergeBase,
    reportPath,
    reportStatus: report.status,
    requiredGateIds: report.requiredGates.map((gate) => gate.id),
    upstream: resolved.upstream,
    upstreamFreshness: resolved.upstreamFreshness,
    upstreamRef: upstream.ref,
    upstreamRepository: upstream.repository,
  });

  if (report.status !== 'clean') {
    process.exitCode = 1;
  }
};

const runGates = async (values: Record<string, string | boolean | undefined>) => {
  const repositoryRoot = path.resolve(requireString(values.repo as string | undefined, 'repo'));
  const reportPath = path.resolve(requireString(values.report as string | undefined, 'report'));
  const rawDirectory = path.resolve(
    requireString(values['raw-dir'] as string | undefined, 'raw-dir'),
  );
  const output = path.resolve(requireString(values.output as string | undefined, 'output'));

  const report = await loadRebaseReport(reportPath);
  const requiredGateIds = report.requiredGates.map((gate) => gate.id);

  const gateResults = await runSelectedGates({
    privacyTargets: [report],
    rawDirectory,
    repositoryRoot,
    requiredGateIds,
  });

  await writeGateResults(output, gateResults);

  const failed = gateResults.some((gate) => gate.outcome !== 'passed');
  if (failed) process.exitCode = 1;
};

const runCollect = async (values: Record<string, string | boolean | undefined>) => {
  const reportPath = path.resolve(requireString(values.report as string | undefined, 'report'));
  const gatesPath = path.resolve(requireString(values.gates as string | undefined, 'gates'));
  const commitsPath = path.resolve(requireString(values.commits as string | undefined, 'commits'));
  const outputDirectory = path.resolve(
    requireString(values['output-dir'] as string | undefined, 'output-dir'),
  );
  const cleanupResult = requireString(
    values['cleanup-result'] as string | undefined,
    'cleanup-result',
  );
  if (cleanupResult !== 'passed' && cleanupResult !== 'failed') {
    throw new Error('--cleanup-result must be passed or failed');
  }
  const upstreamRepository = requireString(
    values['upstream-repository'] as string | undefined,
    'upstream-repository',
  );
  const upstreamRef = requireString(values['upstream-ref'] as string | undefined, 'upstream-ref');
  const upstreamFreshness = requireString(
    values['upstream-freshness'] as string | undefined,
    'upstream-freshness',
  );
  if (upstreamFreshness !== 'verified-by-ci-fetch' && upstreamFreshness !== 'unverified') {
    throw new Error('--upstream-freshness must be verified-by-ci-fetch or unverified');
  }

  const report = await loadRebaseReport(reportPath);
  const gateResults = JSON.parse(await readFile(gatesPath, 'utf8'));
  const commits = JSON.parse(await readFile(commitsPath, 'utf8')) as {
    base: string;
    candidate: string;
    mergeBase: string;
    upstream: string;
  };

  const evidence = await collectUpstreamRebaseEvidence({
    cleanupResult,
    fullCommits: commits,
    gateResults,
    outputDirectory,
    report,
    upstreamFreshness,
    upstreamRef,
    upstreamRepository,
  });

  assertEvidencePassing(evidence);
};

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'candidate-ref': { type: 'string' },
      'candidate-repo': { type: 'string' },
      'cleanup-result': { type: 'string' },
      'commits': { type: 'string' },
      'gates': { type: 'string' },
      'output': { type: 'string' },
      'output-dir': { type: 'string' },
      'raw-dir': { type: 'string' },
      'ref': { type: 'string' },
      'repo': { type: 'string' },
      'report': { type: 'string' },
      'repository': { type: 'string' },
      'temp-dir': { type: 'string' },
      'upstream-freshness': { type: 'string' },
      'upstream-ref': { type: 'string' },
      'upstream-repository': { type: 'string' },
    },
    strict: true,
  });

  const command = positionals[0] as Command | undefined;
  if (!command) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }

  try {
    switch (command) {
      case 'validate-inputs': {
        await runValidateInputs(values);
        break;
      }
      case 'fetch': {
        await runFetch(values);
        break;
      }
      case 'run-gates': {
        await runGates(values);
        break;
      }
      case 'collect': {
        await runCollect(values);
        break;
      }
      default: {
        process.stderr.write(usage);
        process.exitCode = 2;
      }
    }
  } catch (error) {
    process.stderr.write(
      `Upstream rebase CI failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 2;
  }
};

export { removeDirectoryExact };

if (import.meta.main) {
  await main();
}
