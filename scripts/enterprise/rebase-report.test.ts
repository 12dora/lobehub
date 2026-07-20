// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeRebase,
  formatRebaseReport,
  parsePatchLedger,
  parseRebaseReportArgs,
  runRebaseReportCli,
} from './rebase-report';

const temporaryRoots: string[] = [];

const runGit = async (repositoryRoot: string, ...args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryRoot, ...args], {
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
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8').trim());
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });

const writeRepositoryFile = async (repositoryRoot: string, relativePath: string, value: string) => {
  const absolutePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value, 'utf8');
};

const commitAll = async (repositoryRoot: string, message: string) => {
  await runGit(repositoryRoot, 'add', '--all');
  await runGit(repositoryRoot, 'commit', '--quiet', '-m', message);
  return runGit(repositoryRoot, 'rev-parse', 'HEAD');
};

const createRepository = async (registeredPatterns: string[] = []) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'aihub-rebase-report-test-'));
  temporaryRoots.push(repositoryRoot);
  await runGit(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
  await runGit(repositoryRoot, 'config', 'user.email', 'rebase-report@example.invalid');
  await runGit(repositoryRoot, 'config', 'user.name', 'Rebase Report Test');

  const rows = registeredPatterns.map(
    (pattern) => `| \`${pattern}\` | test mount | M15 | 高 | focused regression |`,
  );
  const ledger = [
    '# 上游直接修改点台账',
    '',
    '| 上游文件 / 区域 | 修改目的 | 模块 | 冲突风险 | 控制方式 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  await writeRepositoryFile(
    repositoryRoot,
    'docs/redevelopment/list/07_上游直接修改点台账.md',
    ledger,
  );
  await writeRepositoryFile(repositoryRoot, 'src/core.ts', 'export const value = "base";\n');
  const base = await commitAll(repositoryRoot, 'base');

  await runGit(repositoryRoot, 'switch', '--quiet', '-c', 'upstream');
  await writeRepositoryFile(repositoryRoot, 'upstream-only.ts', 'export const upstream = true;\n');
  const upstream = await commitAll(repositoryRoot, 'upstream SECRET_COMMIT_MESSAGE');

  await runGit(repositoryRoot, 'switch', '--quiet', '-c', 'candidate', base);
  return { base, repositoryRoot, upstream };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((temporaryRoot) => rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true })),
  );
});

describe('parsePatchLedger', () => {
  it('expands brace patterns and preserves module risk metadata', () => {
    const entries = parsePatchLedger(
      [
        '| 上游文件 / 区域 | 修改目的 | 模块 | 冲突风险 | 控制方式 |',
        '| --- | --- | --- | --- | --- |',
        '| `src/{auth,redis}/**` | gate | M13/M14 | 高 | test |',
      ].join('\n'),
    );

    expect(entries).toEqual([
      { module: 'M13/M14', pattern: 'src/auth/**', risk: 'high' },
      { module: 'M13/M14', pattern: 'src/redis/**', risk: 'high' },
    ]);
  });
});

describe('analyzeRebase', () => {
  it('produces a stable clean report without exposing ref names or repository content', async () => {
    const { base, repositoryRoot, upstream } = await createRepository(['src/core.ts']);
    await writeRepositoryFile(
      repositoryRoot,
      'src/enterprise/private.ts',
      'export const token = "SECRET_FILE_CONTENT";\n',
    );
    const candidate = await commitAll(repositoryRoot, 'candidate SECRET_CANDIDATE_MESSAGE');
    const analysisRoot = await mkdtemp(path.join(tmpdir(), 'aihub-rebase-analysis-test-'));
    temporaryRoots.push(analysisRoot);

    const options = {
      baseRef: base,
      candidateRef: 'candidate',
      repositoryRoot,
      temporaryDirectoryRoot: analysisRoot,
      upstreamRef: 'upstream',
    };
    const first = await analyzeRebase(options);
    const second = await analyzeRebase(options);
    const json = formatRebaseReport(first, 'json');
    const markdown = formatRebaseReport(first, 'markdown');

    expect(first.status).toBe('clean');
    expect(first.analysis).toEqual({
      networkAccess: 'not-used',
      upstreamFreshness: 'unverified',
      upstreamFreshnessReason: 'upstream-remote-not-configured',
      worktreeMutation: 'none',
    });
    expect(first.commits).toEqual({
      base: base.slice(0, 12),
      candidate: candidate.slice(0, 12),
      mergeBase: base.slice(0, 12),
      upstream: upstream.slice(0, 12),
    });
    expect(second).toEqual(first);
    expect(JSON.parse(json)).toEqual(first);
    expect(markdown).toContain('Status: **clean**');
    expect(`${json}${markdown}`).not.toMatch(
      /SECRET_FILE_CONTENT|SECRET_COMMIT_MESSAGE|SECRET_CANDIDATE_MESSAGE/u,
    );
    expect(await readdir(analysisRoot)).toEqual([]);
  });

  it('reports registered direct-edit conflicts and their required gates', async () => {
    const { base, repositoryRoot } = await createRepository(['src/core.ts']);
    await runGit(repositoryRoot, 'switch', '--quiet', 'upstream');
    await writeRepositoryFile(repositoryRoot, 'src/core.ts', 'export const value = "upstream";\n');
    const upstream = await commitAll(repositoryRoot, 'upstream conflict');
    await runGit(repositoryRoot, 'switch', '--quiet', 'candidate');
    await writeRepositoryFile(repositoryRoot, 'src/core.ts', 'export const value = "candidate";\n');
    const candidate = await commitAll(repositoryRoot, 'candidate conflict');

    const report = await analyzeRebase({
      baseRef: base,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    expect(report.status).toBe('conflicts');
    expect(report.conflicts).toEqual(['src/core.ts']);
    expect(report.directModificationHotspots).toEqual([
      { modules: ['M15'], path: 'src/core.ts', risk: 'high', upstreamChanged: true },
    ]);
    expect(report.patchDrift).toEqual([]);
    expect(report.requiredGates.map(({ id }) => id)).toContain('manual-conflict-review');
  });

  it('fails closed when an upstream direct edit is absent from the ledger', async () => {
    const { base, repositoryRoot, upstream } = await createRepository(['src/registered.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/core.ts', 'export const value = "candidate";\n');
    const candidate = await commitAll(repositoryRoot, 'unregistered direct edit');

    const report = await analyzeRebase({
      baseRef: base,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    expect(report.status).toBe('drift');
    expect(report.patchDrift).toEqual([
      { path: 'src/core.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    expect(report.requiredGates.map(({ id }) => id)).toContain('patch-ledger-update');
  });

  it('rejects a dirty worktree before resolving refs', async () => {
    const { base, repositoryRoot, upstream } = await createRepository(['src/core.ts']);
    await writeRepositoryFile(repositoryRoot, 'dirty-untracked.txt', 'dirty\n');

    await expect(
      analyzeRebase({
        baseRef: base,
        candidateRef: 'missing-candidate',
        repositoryRoot,
        upstreamRef: upstream,
      }),
    ).rejects.toThrow('Repository worktree must be clean');
  });

  it('rejects missing refs and a non-matching explicit merge base', async () => {
    const { base, repositoryRoot, upstream } = await createRepository(['src/core.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/enterprise/candidate.ts', 'export {};\n');
    const candidate = await commitAll(repositoryRoot, 'candidate');

    await expect(
      analyzeRebase({
        baseRef: base,
        candidateRef: 'missing-candidate',
        repositoryRoot,
        upstreamRef: upstream,
      }),
    ).rejects.toThrow('Candidate ref is missing');
    await expect(
      analyzeRebase({
        baseRef: candidate,
        candidateRef: candidate,
        repositoryRoot,
        upstreamRef: upstream,
      }),
    ).rejects.toThrow('Explicit base does not match the unique upstream/candidate merge base');
  });
});

describe('CLI contract', () => {
  it('requires explicit refs and a supported format', () => {
    expect(() => parseRebaseReportArgs([], '/repo')).toThrow('Missing required option: --base');
    expect(() =>
      parseRebaseReportArgs(
        ['--base', 'a', '--upstream', 'b', '--candidate', 'c', '--format', 'yaml'],
        '/repo',
      ),
    ).toThrow('--format must be json or markdown');
  });

  it('returns a stable failure without echoing a missing ref', async () => {
    const { base, repositoryRoot, upstream } = await createRepository(['src/core.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/enterprise/candidate.ts', 'export {};\n');
    await commitAll(repositoryRoot, 'candidate');

    const result = await runRebaseReportCli(
      [
        '--repo',
        repositoryRoot,
        '--base',
        base,
        '--upstream',
        upstream,
        '--candidate',
        'SECRET_MISSING_REF',
      ],
      repositoryRoot,
    );

    expect(result).toEqual({ code: 2, output: 'Rebase report failed: Candidate ref is missing\n' });
    expect(result.output).not.toContain('SECRET_MISSING_REF');
  });
});
