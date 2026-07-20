// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeRebase,
  expandBraces,
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

describe('expandBraces', () => {
  it('expands top-level alternatives without corrupting nested groups', () => {
    expect(expandBraces('src/{auth,redis}/**')).toEqual(['src/auth/**', 'src/redis/**']);
    expect(
      expandBraces(
        'apps/server/src/enterprise/{jobs/agentRollout.ts,services/agentCatalog/{rolloutService,rolloutWorker}.ts}',
      ),
    ).toEqual([
      'apps/server/src/enterprise/jobs/agentRollout.ts',
      'apps/server/src/enterprise/services/agentCatalog/rolloutService.ts',
      'apps/server/src/enterprise/services/agentCatalog/rolloutWorker.ts',
    ]);
    expect(
      expandBraces(
        'src/enterprise/client/{services/adminAgents.ts,features/admin/agents/{AgentDetailPage,RolloutPanel,useAdminAgents,types}.tsx}',
      ),
    ).toEqual([
      'src/enterprise/client/services/adminAgents.ts',
      'src/enterprise/client/features/admin/agents/AgentDetailPage.tsx',
      'src/enterprise/client/features/admin/agents/RolloutPanel.tsx',
      'src/enterprise/client/features/admin/agents/useAdminAgents.tsx',
      'src/enterprise/client/features/admin/agents/types.tsx',
    ]);
  });

  it('fails closed on unbalanced or unparseable brace patterns', () => {
    expect(() => expandBraces('src/{auth,redis/**')).toThrow(
      'Patch ledger contains an unbalanced brace pattern',
    );
    expect(() => expandBraces('src/auth,redis}/**')).toThrow(
      'Patch ledger contains an unbalanced brace pattern',
    );
    expect(() => expandBraces('src/{auth,{redis}/**')).toThrow(
      'Patch ledger contains an unbalanced brace pattern',
    );
    expect(() => expandBraces('src/{}/**')).toThrow(
      'Patch ledger contains an unparseable brace pattern',
    );
    expect(() => expandBraces('src/{auth,}/**')).toThrow(
      'Patch ledger contains an unparseable brace pattern',
    );
    expect(() => expandBraces('src/{only}/**')).toThrow(
      'Patch ledger contains an unparseable brace pattern',
    );
  });
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

  it('expands nested brace ledger lines exactly', () => {
    const entries = parsePatchLedger(
      [
        '| 上游文件 / 区域 | 修改目的 | 模块 | 冲突风险 | 控制方式 |',
        '| --- | --- | --- | --- | --- |',
        '| `apps/server/src/enterprise/{jobs/agentRollout.ts,services/agentCatalog/{rolloutService,rolloutWorker}.ts}` | rollout | M10 | 高 | test |',
      ].join('\n'),
    );

    expect(entries.map(({ pattern }) => pattern)).toEqual([
      'apps/server/src/enterprise/jobs/agentRollout.ts',
      'apps/server/src/enterprise/services/agentCatalog/rolloutService.ts',
      'apps/server/src/enterprise/services/agentCatalog/rolloutWorker.ts',
    ]);
  });

  it('fails closed when a ledger line contains a malformed brace pattern', () => {
    expect(() =>
      parsePatchLedger(
        [
          '| 上游文件 / 区域 | 修改目的 | 模块 | 冲突风险 | 控制方式 |',
          '| --- | --- | --- | --- | --- |',
          '| `src/{auth,redis/**` | broken | M15 | 高 | test |',
        ].join('\n'),
      ),
    ).toThrow('Patch ledger contains an unbalanced brace pattern');
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

  const rebuildUpstreamFromBase = async (repositoryRoot: string, baseCommit: string) => {
    await runGit(repositoryRoot, 'branch', '--force', 'upstream', baseCommit);
    await runGit(repositoryRoot, 'switch', '--quiet', 'upstream');
    await writeRepositoryFile(
      repositoryRoot,
      'upstream-only.ts',
      'export const upstream = true;\n',
    );
    return commitAll(repositoryRoot, 'upstream from prepared base');
  };

  it('scores rename source hotspot and destination drift for registered -> unregistered', async () => {
    const body =
      'export const stableRenameBody = "unique-rename-payload-for-similarity-detection";\n';
    const { repositoryRoot } = await createRepository(['src/registered.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/registered.ts', body);
    const baseWithRegistered = await commitAll(repositoryRoot, 'register source path');
    const upstream = await rebuildUpstreamFromBase(repositoryRoot, baseWithRegistered);

    await runGit(repositoryRoot, 'switch', '--quiet', '-C', 'candidate', baseWithRegistered);
    await runGit(repositoryRoot, 'mv', 'src/registered.ts', 'src/unregistered-destination.ts');
    const candidate = await commitAll(repositoryRoot, 'rename registered to unregistered');

    const report = await analyzeRebase({
      baseRef: baseWithRegistered,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    expect(report.status).toBe('drift');
    // Destination is unregistered drift; registered source is still a hotspot (deleted by rename).
    expect(report.patchDrift).toEqual([
      { path: 'src/unregistered-destination.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    expect(report.directModificationHotspots).toEqual([
      {
        modules: ['M15'],
        path: 'src/registered.ts',
        risk: 'high',
        upstreamChanged: false,
      },
    ]);
    expect(report.requiredGates.map(({ id }) => id)).toContain('patch-ledger-update');
  });

  it('reports drift when an unregistered source is renamed into enterprise-owned destination', async () => {
    const body =
      'export const stableRenameEnterprise = "unique-rename-to-enterprise-destination-body";\n';
    // Ledger pattern is unrelated so the source path stays unregistered.
    const { repositoryRoot } = await createRepository(['src/other-registered.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/unregistered-source.ts', body);
    const baseCommit = await commitAll(repositoryRoot, 'unregistered rename source');
    const upstream = await rebuildUpstreamFromBase(repositoryRoot, baseCommit);

    await runGit(repositoryRoot, 'switch', '--quiet', '-C', 'candidate', baseCommit);
    // Ensure destination parent exists; git mv does not create intermediate directories.
    await mkdir(path.join(repositoryRoot, 'src/enterprise'), { recursive: true });
    await runGit(
      repositoryRoot,
      'mv',
      'src/unregistered-source.ts',
      'src/enterprise/absorbed-from-upstream.ts',
    );
    const candidate = await commitAll(repositoryRoot, 'rename unregistered into enterprise');

    const report = await analyzeRebase({
      baseRef: baseCommit,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    expect(report.status).toBe('drift');
    expect(report.patchDrift).toEqual([
      { path: 'src/unregistered-source.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    // Enterprise-owned destination is not scored as a direct edit hotspot/drift.
    expect(report.directModificationHotspots).toEqual([]);
    expect(report.patchDrift.map(({ path: value }) => value)).not.toContain(
      'src/enterprise/absorbed-from-upstream.ts',
    );
  });

  it('scores unregistered rename source as drift and registered destination as hotspot', async () => {
    const body =
      'export const stableRenameRegisteredDest = "unique-rename-to-registered-destination";\n';
    const { repositoryRoot } = await createRepository(['src/registered-destination.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/unregistered-source.ts', body);
    const baseCommit = await commitAll(repositoryRoot, 'unregistered source for rename');
    const upstream = await rebuildUpstreamFromBase(repositoryRoot, baseCommit);

    await runGit(repositoryRoot, 'switch', '--quiet', '-C', 'candidate', baseCommit);
    await runGit(
      repositoryRoot,
      'mv',
      'src/unregistered-source.ts',
      'src/registered-destination.ts',
    );
    const candidate = await commitAll(repositoryRoot, 'rename unregistered to registered dest');

    const report = await analyzeRebase({
      baseRef: baseCommit,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    expect(report.status).toBe('drift');
    expect(report.patchDrift).toEqual([
      { path: 'src/unregistered-source.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    expect(report.directModificationHotspots).toEqual([
      {
        modules: ['M15'],
        path: 'src/registered-destination.ts',
        risk: 'high',
        upstreamChanged: false,
      },
    ]);
  });

  it('does not treat a copy source as a direct edit while requiring destination ledger coverage', async () => {
    const body =
      'export const stableCopyBody = "unique-copy-payload-for-similarity-detection-0123456789";\n';
    const { repositoryRoot } = await createRepository([
      'src/registered.ts',
      'src/copied-destination.ts',
    ]);
    await writeRepositoryFile(repositoryRoot, 'src/registered.ts', body);
    const baseWithRegistered = await commitAll(repositoryRoot, 'register copy source');
    const upstream = await rebuildUpstreamFromBase(repositoryRoot, baseWithRegistered);

    await runGit(repositoryRoot, 'switch', '--quiet', '-C', 'candidate', baseWithRegistered);
    await writeRepositoryFile(repositoryRoot, 'src/copied-destination.ts', body);
    const candidate = await commitAll(repositoryRoot, 'copy registered to registered destination');

    const cleanReport = await analyzeRebase({
      baseRef: baseWithRegistered,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });
    expect(cleanReport.status).toBe('clean');
    expect(cleanReport.patchDrift).toEqual([]);
    expect(cleanReport.directModificationHotspots).toEqual([
      {
        modules: ['M15'],
        path: 'src/copied-destination.ts',
        risk: 'high',
        upstreamChanged: false,
      },
    ]);
    // Source remains unchanged and must not be scored as a direct edit.
    expect(cleanReport.directModificationHotspots.map(({ path: value }) => value)).not.toContain(
      'src/registered.ts',
    );

    await runGit(
      repositoryRoot,
      'switch',
      '--quiet',
      '-C',
      'candidate-unregistered',
      baseWithRegistered,
    );
    await writeRepositoryFile(repositoryRoot, 'src/unregistered-copy.ts', body);
    const unregisteredCandidate = await commitAll(
      repositoryRoot,
      'copy registered to unregistered destination',
    );
    const driftReport = await analyzeRebase({
      baseRef: baseWithRegistered,
      candidateRef: unregisteredCandidate,
      repositoryRoot,
      upstreamRef: upstream,
    });
    expect(driftReport.status).toBe('drift');
    expect(driftReport.patchDrift).toEqual([
      { path: 'src/unregistered-copy.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    expect(driftReport.directModificationHotspots.map(({ path: value }) => value)).not.toContain(
      'src/registered.ts',
    );
    expect(driftReport.patchDrift.map(({ path: value }) => value)).not.toContain(
      'src/registered.ts',
    );
  });

  it('does not false-positive an unregistered unchanged copy source while applying destination rules', async () => {
    const body =
      'export const stableUnregisteredCopy = "unique-unregistered-copy-source-body-0123456789";\n';
    // Destination is registered; source path is intentionally absent from the ledger.
    const { repositoryRoot } = await createRepository(['src/copied-destination.ts']);
    await writeRepositoryFile(repositoryRoot, 'src/unregistered-source.ts', body);
    const baseCommit = await commitAll(repositoryRoot, 'unregistered copy source present');
    const upstream = await rebuildUpstreamFromBase(repositoryRoot, baseCommit);

    await runGit(repositoryRoot, 'switch', '--quiet', '-C', 'candidate', baseCommit);
    await writeRepositoryFile(repositoryRoot, 'src/copied-destination.ts', body);
    const candidate = await commitAll(
      repositoryRoot,
      'copy unregistered source to registered destination',
    );

    const report = await analyzeRebase({
      baseRef: baseCommit,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstream,
    });

    // Source is unchanged so it must not appear as hotspot or drift.
    expect(report.patchDrift.map(({ path: value }) => value)).not.toContain(
      'src/unregistered-source.ts',
    );
    expect(report.directModificationHotspots.map(({ path: value }) => value)).not.toContain(
      'src/unregistered-source.ts',
    );
    // Destination rules still apply: registered destination is a hotspot, status stays clean.
    expect(report.status).toBe('clean');
    expect(report.directModificationHotspots).toEqual([
      {
        modules: ['M15'],
        path: 'src/copied-destination.ts',
        risk: 'high',
        upstreamChanged: false,
      },
    ]);

    await runGit(
      repositoryRoot,
      'switch',
      '--quiet',
      '-C',
      'candidate-unregistered-dest',
      baseCommit,
    );
    await writeRepositoryFile(repositoryRoot, 'src/unregistered-copy-dest.ts', body);
    const unregisteredDestCandidate = await commitAll(
      repositoryRoot,
      'copy unregistered source to unregistered destination',
    );
    const driftReport = await analyzeRebase({
      baseRef: baseCommit,
      candidateRef: unregisteredDestCandidate,
      repositoryRoot,
      upstreamRef: upstream,
    });
    expect(driftReport.status).toBe('drift');
    expect(driftReport.patchDrift).toEqual([
      { path: 'src/unregistered-copy-dest.ts', reason: 'unregistered-upstream-direct-edit' },
    ]);
    expect(driftReport.patchDrift.map(({ path: value }) => value)).not.toContain(
      'src/unregistered-source.ts',
    );
    expect(driftReport.directModificationHotspots.map(({ path: value }) => value)).not.toContain(
      'src/unregistered-source.ts',
    );
  });

  it('derives post-upgrade gates from enterprise candidate paths and upstream changes', async () => {
    const { base, repositoryRoot } = await createRepository(['src/core.ts']);

    await runGit(repositoryRoot, 'switch', '--quiet', 'upstream');
    await writeRepositoryFile(
      repositoryRoot,
      'packages/database/migrations/meta/_journal.json',
      '{"version":"7","entries":[]}\n',
    );
    await writeRepositoryFile(
      repositoryRoot,
      'src/libs/redis/runtimeConfig.ts',
      'export const runtime = true;\n',
    );
    const upstreamWithGates = await commitAll(repositoryRoot, 'upstream migration and runtime');

    await runGit(repositoryRoot, 'switch', '--quiet', 'candidate');
    await writeRepositoryFile(
      repositoryRoot,
      'apps/server/src/enterprise/routers/admin/rbacPermissions.ts',
      'export const permissionMatrix = true;\n',
    );
    await writeRepositoryFile(
      repositoryRoot,
      'src/spa/router/desktopRouter.config.tsx',
      'export const createAdminRouteTree = () => null;\n',
    );
    const candidate = await commitAll(repositoryRoot, 'enterprise router and spa routes');

    const report = await analyzeRebase({
      baseRef: base,
      candidateRef: candidate,
      repositoryRoot,
      upstreamRef: upstreamWithGates,
    });

    const gateIds = report.requiredGates.map(({ id }) => id);
    expect(report.status).toBe('clean');
    expect(gateIds).toEqual(
      expect.arrayContaining([
        'bun-check-changed',
        'failure-drills',
        'migration-upgrade-rollback',
        'permission-matrix',
        'privacy-review',
        'spa-route-sync',
        'type-check',
      ]),
    );
    expect(gateIds).not.toContain('manual-conflict-review');
    expect(gateIds).not.toContain('patch-ledger-update');
    // Enterprise-owned candidate paths drive gates without becoming direct-edit hotspots.
    expect(report.directModificationHotspots).toEqual([]);
    expect(report.summary.candidateChangedPaths).toBeGreaterThan(0);
    expect(report.summary.upstreamChangedPaths).toBeGreaterThan(0);
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
