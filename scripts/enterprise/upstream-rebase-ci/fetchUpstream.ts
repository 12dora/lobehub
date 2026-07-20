import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { listChangedPathsForGates } from './changedFiles';
import { removePathExact } from './cleanup';
import type { ValidatedUpstreamInput } from './contract';

const HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;
const INITIAL_FETCH_DEPTH = 200;
const DEEPEN_FETCH_DEPTH = 2000;

interface GitResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface GitBufferResult {
  code: number;
  stderr: Buffer;
  stdout: Buffer;
}

const runGitBuffers = (cwd: string | undefined, args: string[]): Promise<GitBufferResult> =>
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
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
  });

const runGit = async (cwd: string | undefined, args: string[]): Promise<GitResult> => {
  const result = await runGitBuffers(cwd, args);
  return {
    code: result.code,
    stderr: result.stderr.toString('utf8'),
    stdout: result.stdout.toString('utf8'),
  };
};

const gitOutput = async (cwd: string | undefined, args: string[], failure: string) => {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(failure);
  }
  return result.stdout.trim();
};

/**
 * Read raw `git status --porcelain=v1 -z` stdout bytes.
 * Never UTF-8-decode or trim — leading spaces and non-UTF8 path bytes must be preserved.
 */
export const readRawPorcelainStatus = async (repositoryRoot: string): Promise<Buffer> => {
  const result = await runGitBuffers(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (result.code !== 0) {
    throw new Error('Unable to read source status');
  }
  return result.stdout;
};

export interface ResolvedCommits {
  analysisRepository: string;
  base: string;
  candidate: string;
  changedPaths: string[];
  integratedTree: string;
  integrationRepository: string;
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

export interface SourceSnapshot {
  head: string;
  /** SHA-256 of the exact raw `git status --porcelain=v1 -z` stdout Buffer (not a length). */
  statusDigest: string;
}

/** Hash raw porcelain status bytes. Accept Buffer only — never decode/trim first. */
export const digestPorcelainStatus = (porcelain: Buffer): string =>
  createHash('sha256').update(porcelain).digest('hex');

/**
 * Capture HEAD + raw porcelain digest. Source must already be clean (empty porcelain).
 */
export const captureSourceSnapshot = async (repositoryRoot: string): Promise<SourceSnapshot> => {
  const head = await gitOutput(
    repositoryRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    'Unable to read source HEAD',
  );
  const status = await readRawPorcelainStatus(repositoryRoot);
  if (status.length > 0) {
    throw new Error('Source worktree must be clean before dry-run integration work');
  }
  return { head, statusDigest: digestPorcelainStatus(status) };
};

export const assertSourceUnchanged = async (
  repositoryRoot: string,
  snapshot: SourceSnapshot,
): Promise<void> => {
  const head = await gitOutput(
    repositoryRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    'Unable to read source HEAD',
  );
  const status = await readRawPorcelainStatus(repositoryRoot);
  const statusDigest = digestPorcelainStatus(status);
  if (head !== snapshot.head) {
    throw new Error('Source worktree HEAD changed during dry-run');
  }
  if (statusDigest !== snapshot.statusDigest) {
    throw new Error('Source worktree porcelain status changed during dry-run');
  }
  if (status.length > 0) {
    throw new Error('Source worktree is dirty after dry-run step');
  }
};

/**
 * Materialize the clean merge-tree result of candidate+upstream into an owned
 * temporary detached repository under temporaryDirectory only.
 */
export const materializeIntegrationTree = async ({
  analysisRepository,
  base,
  candidate,
  temporaryDirectory,
  upstream,
}: {
  analysisRepository: string;
  base: string;
  candidate: string;
  temporaryDirectory: string;
  upstream: string;
}): Promise<{
  changedPaths: string[];
  integratedTree: string;
  integrationRepository: string;
}> => {
  const mergeTree = await runGit(analysisRepository, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--messages',
    '--end-of-options',
    candidate,
    upstream,
  ]);
  if (mergeTree.code === 1) {
    throw new Error('Integration merge-tree reported conflicts');
  }
  if (mergeTree.code !== 0) {
    throw new Error('Unable to write integration merge-tree');
  }

  const lines = mergeTree.stdout.split('\n');
  const treeOid = lines[0]?.trim();
  if (!treeOid || !HASH_PATTERN.test(treeOid)) {
    throw new Error('Integration merge-tree did not return a tree oid');
  }

  const integrationRepository = path.join(temporaryDirectory, 'integration');
  await rm(integrationRepository, { force: true, maxRetries: 3, recursive: true });

  const clone = await runGit(undefined, [
    'clone',
    '--quiet',
    '--shared',
    '--no-checkout',
    '--',
    analysisRepository,
    integrationRepository,
  ]);
  if (clone.code !== 0) {
    throw new Error('Unable to create isolated integration repository');
  }

  // Create a disposable commit object for the integrated tree (fixed message, no secrets).
  const integratedCommit = await gitOutput(
    integrationRepository,
    ['commit-tree', treeOid, '-m', 'integration-dry-run'],
    'Unable to create integration commit from merge-tree',
  );
  if (!HASH_PATTERN.test(integratedCommit)) {
    throw new Error('Integrated commit oid is invalid');
  }

  const checkout = await runGit(integrationRepository, [
    'checkout',
    '--quiet',
    '--force',
    '--detach',
    '--end-of-options',
    integratedCommit,
  ]);
  if (checkout.code !== 0) {
    // Fallback: read-tree into an empty index/worktree
    await runGit(integrationRepository, [
      'read-tree',
      '--reset',
      '-u',
      '--end-of-options',
      treeOid,
    ]);
    const statusAfterRead = await gitOutput(
      integrationRepository,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      'Unable to inspect integration repository after read-tree',
    );
    if (statusAfterRead.length > 0) {
      throw new Error('Integration repository is dirty after read-tree materialization');
    }
  }

  const status = await gitOutput(
    integrationRepository,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'Unable to inspect integration repository status',
  );
  if (status.length > 0) {
    throw new Error('Integration repository worktree is not clean');
  }

  const changedPaths = await listChangedPathsForGates(
    analysisRepository,
    base,
    candidate,
    upstream,
  );

  return {
    changedPaths,
    integratedTree: treeOid,
    integrationRepository,
  };
};

/**
 * Build an isolated analysis clone, fetch the official upstream ref into it only,
 * resolve SHAs, and materialize the candidate+upstream integration tree for gates.
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

    const unshallowCandidate = await runGit(analysisRepository, [
      'fetch',
      '--quiet',
      '--unshallow',
      '--end-of-options',
      'origin',
    ]);
    if (unshallowCandidate.code !== 0) {
      await runGit(analysisRepository, ['fetch', '--quiet', '--end-of-options', 'origin']);
    }

    mergeBase = await resolveMergeBase();
  }

  if (!mergeBase) {
    throw new Error('Unable to resolve a unique merge-base between upstream and candidate');
  }

  await runGit(analysisRepository, ['remote', 'remove', 'official-upstream']);

  const integration = await materializeIntegrationTree({
    analysisRepository,
    base: mergeBase,
    candidate: candidateSha,
    temporaryDirectory,
    upstream: upstreamSha,
  });

  return {
    analysisRepository,
    base: mergeBase,
    candidate: candidateSha,
    changedPaths: integration.changedPaths,
    integratedTree: integration.integratedTree,
    integrationRepository: integration.integrationRepository,
    mergeBase,
    upstream: upstreamSha,
    upstreamFreshness: 'verified-by-ci-fetch',
  };
};

export const removeDirectoryExact = (target: string) => removePathExact(target);
