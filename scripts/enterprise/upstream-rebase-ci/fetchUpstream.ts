import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ValidatedUpstreamInput } from './contract';

const HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;
const INITIAL_FETCH_DEPTH = 200;
const DEEPEN_FETCH_DEPTH = 2000;

interface GitResult {
  code: number;
  stderr: string;
  stdout: string;
}

const runGit = (cwd: string | undefined, args: string[]): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...(cwd ? ['-C', cwd] : []), ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code: code ?? 2,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });

const gitOutput = async (cwd: string | undefined, args: string[], failure: string) => {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(failure);
  }
  return result.stdout.trim();
};

export interface ResolvedCommits {
  analysisRepository: string;
  base: string;
  candidate: string;
  mergeBase: string;
  upstream: string;
  upstreamFreshness: 'verified-by-ci-fetch';
}

export interface FetchUpstreamOptions {
  candidateRef?: string;
  candidateRepository: string;
  temporaryDirectory: string;
  upstream: ValidatedUpstreamInput;
}

/**
 * Build an isolated analysis clone, fetch the official upstream ref into it only,
 * and resolve base/upstream/candidate SHAs. Never mutates the source worktree refs
 * with checkout/reset/merge onto main.
 */
export const prepareIsolatedAnalysisRepository = async ({
  candidateRef,
  candidateRepository,
  temporaryDirectory,
  upstream,
}: FetchUpstreamOptions): Promise<ResolvedCommits> => {
  await mkdir(temporaryDirectory, { recursive: true });
  const analysisRepository = path.join(temporaryDirectory, 'analysis');

  await rm(analysisRepository, { force: true, maxRetries: 3, recursive: true });

  const candidateSha = await gitOutput(
    candidateRepository,
    [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${candidateRef && candidateRef.length > 0 ? candidateRef : 'HEAD'}^{commit}`,
    ],
    'Candidate ref is missing',
  );
  if (!HASH_PATTERN.test(candidateSha)) {
    throw new Error('Candidate SHA is invalid');
  }

  // Shared clone reuses local objects; checkout keeps worktree clean for the report.
  const clone = await runGit(undefined, [
    'clone',
    '--quiet',
    '--shared',
    '--no-checkout',
    '--',
    candidateRepository,
    analysisRepository,
  ]);
  if (clone.code !== 0) {
    throw new Error('Unable to create isolated analysis repository');
  }

  const checkout = await runGit(analysisRepository, [
    'checkout',
    '--quiet',
    '--force',
    '--detach',
    '--end-of-options',
    candidateSha,
  ]);
  if (checkout.code !== 0) {
    throw new Error('Unable to detach isolated analysis repository at candidate');
  }

  const status = await gitOutput(
    analysisRepository,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'Unable to inspect isolated repository status',
  );
  if (status.length > 0) {
    throw new Error('Isolated analysis repository worktree is not clean');
  }

  // Fetch official upstream into the temporary clone only (not the source worktree).
  const addRemote = await runGit(analysisRepository, [
    'remote',
    'add',
    'official-upstream',
    '--',
    upstream.fetchUrl,
  ]);
  if (addRemote.code !== 0) {
    throw new Error('Unable to configure official upstream remote in isolated clone');
  }

  const fetchBounded = await runGit(analysisRepository, [
    'fetch',
    '--quiet',
    '--no-tags',
    `--depth=${INITIAL_FETCH_DEPTH}`,
    '--end-of-options',
    'official-upstream',
    upstream.ref,
  ]);
  if (fetchBounded.code !== 0) {
    throw new Error('Unable to fetch official upstream ref into isolated clone');
  }

  let upstreamSha = await gitOutput(
    analysisRepository,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'FETCH_HEAD^{commit}'],
    'Fetched upstream ref did not resolve to a commit',
  );
  if (!HASH_PATTERN.test(upstreamSha)) {
    throw new Error('Fetched upstream SHA is invalid');
  }

  // Ensure candidate is fully present under a named ref for merge-base clarity.
  const candidatePoint = await runGit(analysisRepository, [
    'update-ref',
    'refs/dry-run/candidate',
    candidateSha,
  ]);
  if (candidatePoint.code !== 0) {
    throw new Error('Unable to record candidate SHA in isolated clone');
  }

  const upstreamPoint = await runGit(analysisRepository, [
    'update-ref',
    'refs/dry-run/upstream',
    upstreamSha,
  ]);
  if (upstreamPoint.code !== 0) {
    throw new Error('Unable to record upstream SHA in isolated clone');
  }

  const resolveMergeBase = async () => {
    const result = await runGit(analysisRepository, [
      'merge-base',
      '--all',
      '--end-of-options',
      upstreamSha,
      candidateSha,
    ]);
    if (result.code !== 0) return null;
    const bases = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (bases.length !== 1 || !HASH_PATTERN.test(bases[0])) return null;
    return bases[0];
  };

  let mergeBase = await resolveMergeBase();
  if (!mergeBase) {
    // Escalate history depth for both ends when the bounded fetch is insufficient.
    const deepenUpstream = await runGit(analysisRepository, [
      'fetch',
      '--quiet',
      '--no-tags',
      `--deepen=${DEEPEN_FETCH_DEPTH}`,
      '--end-of-options',
      'official-upstream',
      upstream.ref,
    ]);
    if (deepenUpstream.code !== 0) {
      // Fall back to full upstream history when deepen is unsupported/insufficient.
      const fullUpstream = await runGit(analysisRepository, [
        'fetch',
        '--quiet',
        '--no-tags',
        '--unshallow',
        '--end-of-options',
        'official-upstream',
        upstream.ref,
      ]);
      if (fullUpstream.code !== 0) {
        // Some clones are already full-depth; retry a plain fetch of the ref.
        const plain = await runGit(analysisRepository, [
          'fetch',
          '--quiet',
          '--no-tags',
          '--end-of-options',
          'official-upstream',
          upstream.ref,
        ]);
        if (plain.code !== 0) {
          throw new Error('Unable to escalate upstream history for merge-base');
        }
      }
    }

    upstreamSha = await gitOutput(
      analysisRepository,
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'FETCH_HEAD^{commit}'],
      'Escalated upstream fetch did not resolve to a commit',
    );
    await runGit(analysisRepository, ['update-ref', 'refs/dry-run/upstream', upstreamSha]);

    // Candidate may also be shallow in CI; unshallow the shared object source via this clone.
    const unshallowCandidate = await runGit(analysisRepository, [
      'fetch',
      '--quiet',
      '--unshallow',
      '--end-of-options',
      'origin',
    ]);
    if (unshallowCandidate.code !== 0) {
      // origin may already be full-depth when checkout used fetch-depth: 0.
      await runGit(analysisRepository, ['fetch', '--quiet', '--end-of-options', 'origin']);
    }

    mergeBase = await resolveMergeBase();
  }

  if (!mergeBase) {
    throw new Error('Unable to resolve a unique merge-base between upstream and candidate');
  }

  // Drop the remote URL from the isolated clone config before analysis/report.
  // Evidence must not retain raw remote URLs; objects/refs already resolved.
  await runGit(analysisRepository, ['remote', 'remove', 'official-upstream']);

  return {
    analysisRepository,
    base: mergeBase,
    candidate: candidateSha,
    mergeBase,
    upstream: upstreamSha,
    upstreamFreshness: 'verified-by-ci-fetch',
  };
};

export const removeDirectoryExact = async (target: string) => {
  await rm(target, { force: true, maxRetries: 3, recursive: true });
  const probe = await runGit(undefined, ['-C', target, 'rev-parse', '--is-inside-work-tree']);
  if (probe.code === 0) {
    throw new Error('Cleanup failed: temporary repository still present');
  }
};
