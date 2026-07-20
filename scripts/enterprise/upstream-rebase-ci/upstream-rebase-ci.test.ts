// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { filterExistingLintablePaths } from './changedFiles';
import { removePathExact } from './cleanup';
import {
  createUpstreamRebaseEvidence,
  EXPECTED_GATE_KINDS,
  isPassingUpstreamRebaseEvidence,
  KNOWN_GATE_IDS,
  scanUpstreamRebaseEvidence,
  UPSTREAM_REBASE_CI_LANE,
  UPSTREAM_REBASE_CI_SCHEMA_VERSION,
} from './contract';
import { materializeIntegrationTree } from './fetchUpstream';
import {
  detectAutofixMutation,
  GATE_DEFINITIONS,
  resolveGateDefinition,
  selectBunCheckPaths,
  VITEST_OUTPUT_PLACEHOLDER,
} from './gates';
import {
  assertReportCommitsMatch,
  parseCommitsFileStrict,
  parseGateResultsStrict,
  parseRebaseReportStrict,
} from './schemas';
import { scanForSecrets, scanSerializedTextForSecrets, SECRET_FAMILY_SAMPLES } from './secretScan';
import {
  buildOfficialFetchUrl,
  validateUpstreamInputs,
  validateUpstreamRef,
  validateUpstreamRepository,
} from './validateInputs';

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/enterprise-upstream-rebase.yml',
);
const SYNC_WORKFLOW_PATH = path.resolve(process.cwd(), '.github/workflows/sync.yml');

const FULL_SHA = 'a'.repeat(40);
const SHORT = FULL_SHA.slice(0, 12);

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
      reject(new Error(Buffer.concat(stderr).toString('utf8') || `git failed: ${args.join(' ')}`));
    });
  });

const writeRepoFile = async (repositoryRoot: string, relativePath: string, value: string) => {
  const absolutePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value, 'utf8');
};

const commitAll = async (repositoryRoot: string, message: string) => {
  await runGit(repositoryRoot, 'add', '--all');
  await runGit(repositoryRoot, 'commit', '--quiet', '-m', message);
  return runGit(repositoryRoot, 'rev-parse', 'HEAD');
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((temporaryRoot) => rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true })),
  );
});

const baseReport = () =>
  parseRebaseReportStrict({
    analysis: {
      networkAccess: 'not-used',
      upstreamFreshness: 'unverified',
      upstreamFreshnessReason: 'upstream-remote-not-configured',
      worktreeMutation: 'none',
    },
    commits: {
      base: SHORT,
      candidate: SHORT,
      mergeBase: SHORT,
      upstream: SHORT,
    },
    conflicts: [],
    directModificationHotspots: [],
    patchDrift: [],
    requiredGates: [
      { id: 'bun-check-changed', reason: 'changed' },
      { id: 'privacy-review', reason: 'privacy' },
      { id: 'type-check', reason: 'types' },
    ],
    schemaVersion: 1,
    status: 'clean',
    summary: {
      candidateChangedPaths: 1,
      conflicts: 0,
      directModificationHotspots: 0,
      patchDrift: 0,
      upstreamChangedPaths: 1,
    },
  });

const extractRunBlocks = (workflowSource: string): string[] => {
  const document = parse(workflowSource) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  const blocks: string[] = [];
  for (const job of Object.values(document.jobs)) {
    for (const step of job.steps) {
      if (typeof step.run === 'string' && step.run.trim().length > 0) {
        blocks.push(step.run);
      }
    }
  }
  return blocks;
};

describe('validateUpstreamInputs', () => {
  it('accepts official owner/name defaults and builds a credential-free HTTPS URL', () => {
    const validated = validateUpstreamInputs({});
    expect(validated).toEqual({
      fetchUrl: 'https://github.com/lobehub/lobehub.git',
      ref: 'main',
      repository: 'lobehub/lobehub',
    });
    expect(buildOfficialFetchUrl('lobehub/lobehub')).toBe('https://github.com/lobehub/lobehub.git');
  });

  it('rejects arbitrary URLs, credentials, and shell metacharacters', () => {
    expect(() => validateUpstreamRepository('https://github.com/lobehub/lobehub.git')).toThrow(
      /owner\/name|URL/,
    );
    expect(() => validateUpstreamRepository('lobehub/lobehub.git')).toThrow();
    expect(() => validateUpstreamRepository('user:token@host/repo')).toThrow();
    expect(() => validateUpstreamRepository('lobehub/lobehub;rm -rf /')).toThrow();
    expect(() => validateUpstreamRef('main;curl evil')).toThrow();
    expect(() => validateUpstreamRef('feature/../main')).toThrow();
  });
});

describe('gate mapping', () => {
  it('maps every known gate deterministically and fail-closes runtime-only gates', () => {
    for (const id of KNOWN_GATE_IDS) {
      const definition = resolveGateDefinition(id);
      expect(definition.kind).toBe(EXPECTED_GATE_KINDS[id]);
    }
    expect(GATE_DEFINITIONS['failure-drills'].failClosed).toBe(true);
    expect(GATE_DEFINITIONS['failure-drills'].kind).toBe('fail-closed');
    expect(GATE_DEFINITIONS['bun-check-changed'].runner).toBe('bun-check-changed');
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].runner).toBe(
      'migration-upgrade-rollback',
    );
    expect(resolveGateDefinition('not-a-real-gate').failClosed).toBe(true);

    for (const id of KNOWN_GATE_IDS) {
      const definition = GATE_DEFINITIONS[id];
      if (definition.kind !== 'vitest' || definition.runner) continue;
      expect(definition.argv).toContain('--outputFile');
      expect(definition.argv).toContain(VITEST_OUTPUT_PLACEHOLDER);
    }
  });
});

describe('strict schemas', () => {
  it('rejects duplicate/extra/missing/wrong-kind/malformed gates and contradictory summaries', () => {
    const report = baseReport();
    expect(() =>
      parseRebaseReportStrict({
        ...report,
        summary: { ...report.summary, conflicts: 2 },
      }),
    ).toThrow(/summary.conflicts/);

    expect(() =>
      parseRebaseReportStrict({
        ...report,
        requiredGates: [
          { id: 'type-check', reason: 'a' },
          { id: 'type-check', reason: 'b' },
        ],
      }),
    ).toThrow(/unique/);

    const required = ['bun-check-changed', 'privacy-review', 'type-check'];
    expect(() =>
      parseGateResultsStrict(
        [
          {
            id: 'bun-check-changed',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
          },
          {
            id: 'bun-check-changed',
            kind: 'command',
            outcome: 'passed',
            reason: 'dup',
          },
          {
            id: 'privacy-review',
            kind: 'privacy-scan',
            outcome: 'passed',
            reason: 'ok',
          },
        ],
        required,
      ),
    ).toThrow(/unique/);

    expect(() =>
      parseGateResultsStrict(
        [
          {
            id: 'bun-check-changed',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
          },
          {
            id: 'privacy-review',
            kind: 'privacy-scan',
            outcome: 'passed',
            reason: 'ok',
          },
        ],
        required,
      ),
    ).toThrow(/exactly match/);

    expect(() =>
      parseGateResultsStrict(
        [
          {
            id: 'bun-check-changed',
            kind: 'vitest',
            outcome: 'passed',
            reason: 'wrong kind',
            assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
          },
          {
            id: 'privacy-review',
            kind: 'privacy-scan',
            outcome: 'passed',
            reason: 'ok',
          },
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
          },
        ],
        required,
      ),
    ).toThrow(/kind/);

    expect(() =>
      parseGateResultsStrict(
        [
          {
            id: 'bun-check-changed',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
          },
          {
            id: 'privacy-review',
            kind: 'privacy-scan',
            outcome: 'passed',
            reason: 'ok',
          },
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
            assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
          },
        ],
        required,
      ),
    ).toThrow(/assertions/);

    const commits = parseCommitsFileStrict({
      base: FULL_SHA,
      candidate: FULL_SHA,
      mergeBase: FULL_SHA,
      upstream: FULL_SHA,
    });
    expect(() =>
      assertReportCommitsMatch(report, {
        ...commits,
        upstream: 'b'.repeat(40),
      }),
    ).toThrow(/does not match/);
  });
});

describe('secret scanner families', () => {
  it('detects AWS, OpenAI, Slack, Google, GitHub, private keys, and DB URLs', () => {
    for (const [family, sample] of Object.entries(SECRET_FAMILY_SAMPLES)) {
      expect(scanSerializedTextForSecrets(sample).result, family).toBe('failed');
      expect(scanForSecrets({ note: sample }).result, family).toBe('failed');
    }
    expect(scanSerializedTextForSecrets('ordinary documentation without credentials').result).toBe(
      'passed',
    );
    expect(scanUpstreamRebaseEvidence({ status: 'clean', count: 1 }).result).toBe('passed');
  });
});

describe('cleanup exit semantics', () => {
  it('fails when rm exits nonzero even if the path is already gone', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'cleanup-gone-'));
    temporaryRoots.push(target);
    await expect(
      removePathExact(target, async () => {
        await rm(target, { force: true, recursive: true });
        return { code: 1 };
      }),
    ).rejects.toThrow(/exited 1/);
  });

  it('fails when rm exits nonzero and the path remains (partial deletion)', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'cleanup-partial-'));
    temporaryRoots.push(target);
    await expect(removePathExact(target, async () => ({ code: 1 }))).rejects.toThrow(/exited 1/);
    // still exists for afterEach cleanup
  });

  it('succeeds only when rm exits 0 and path is absent', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'cleanup-ok-'));
    await removePathExact(target);
    await expect(removePathExact(target)).resolves.toBeUndefined();
  });
});

describe('integration tree materialization', () => {
  it('rejects an integrated tree that introduces a TypeScript type error', async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'integration-typeerror-'));
    temporaryRoots.push(repositoryRoot);
    await runGit(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
    await runGit(repositoryRoot, 'config', 'user.email', 'integration@example.invalid');
    await runGit(repositoryRoot, 'config', 'user.name', 'Integration Test');

    await writeRepoFile(
      repositoryRoot,
      'package.json',
      JSON.stringify({ name: 'fixture', private: true, scripts: { 'type-check': 'tsc --noEmit' } }),
    );
    await writeRepoFile(
      repositoryRoot,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    );
    await writeRepoFile(repositoryRoot, 'src/value.ts', 'export const value: number = 1;\n');
    const base = await commitAll(repositoryRoot, 'base');

    await runGit(repositoryRoot, 'switch', '--quiet', '-c', 'upstream');
    await writeRepoFile(
      repositoryRoot,
      'src/value.ts',
      'export const value: number = "TYPE_ERROR_FROM_UPSTREAM";\n',
    );
    const upstream = await commitAll(repositoryRoot, 'upstream type error');

    await runGit(repositoryRoot, 'switch', '--quiet', '-c', 'candidate', base);
    await writeRepoFile(repositoryRoot, 'src/ok.ts', 'export const ok = true;\n');
    const candidate = await commitAll(repositoryRoot, 'candidate');

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'integration-materialize-'));
    temporaryRoots.push(temporaryDirectory);

    // Analysis-style shared clone for object access
    const analysisRepository = path.join(temporaryDirectory, 'analysis');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'git',
        ['clone', '--quiet', '--shared', '--', repositoryRoot, analysisRepository],
        { stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('clone failed'))));
    });

    const integration = await materializeIntegrationTree({
      analysisRepository,
      base,
      candidate,
      temporaryDirectory,
      upstream,
    });

    const integratedSource = await readFile(
      path.join(integration.integrationRepository, 'src/value.ts'),
      'utf8',
    );
    expect(integratedSource).toContain('TYPE_ERROR_FROM_UPSTREAM');

    // Install typescript for the fixture type-check
    await writeRepoFile(
      integration.integrationRepository,
      'package.json',
      JSON.stringify({
        name: 'fixture',
        private: true,
        scripts: { 'type-check': 'tsc --noEmit' },
        devDependencies: { typescript: '5.8.3' },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pnpm', ['install'], {
        cwd: integration.integrationRepository,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('pnpm install failed')),
      );
    });

    const typeCheck = await new Promise<{ code: number }>((resolve, reject) => {
      const child = spawn('bun', ['run', 'type-check'], {
        cwd: integration.integrationRepository,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 2 }));
    });
    expect(typeCheck.code).not.toBe(0);
  }, 120_000);
});

describe('bun-check-changed selection and autofix false green', () => {
  it('retains non-orchestration changed files instead of only CI scripts', async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'bun-check-paths-'));
    temporaryRoots.push(repositoryRoot);
    await writeRepoFile(
      repositoryRoot,
      'scripts/enterprise/upstream-rebase-ci/gates.ts',
      'export {};\n',
    );
    await writeRepoFile(repositoryRoot, 'src/app/feature.ts', 'export const feature = true;\n');
    const existing = await filterExistingLintablePaths(repositoryRoot, [
      'scripts/enterprise/upstream-rebase-ci/gates.ts',
      'src/app/feature.ts',
      'docs/only.md',
    ]);
    await writeRepoFile(repositoryRoot, 'docs/only.md', '# x\n');
    const existingWithDocs = await filterExistingLintablePaths(repositoryRoot, [
      'scripts/enterprise/upstream-rebase-ci/gates.ts',
      'src/app/feature.ts',
      'docs/only.md',
    ]);
    const selected = selectBunCheckPaths(existingWithDocs);
    expect(selected).toContain('src/app/feature.ts');
    expect(selected).toContain('scripts/enterprise/upstream-rebase-ci/gates.ts');
    expect(selected).not.toEqual([
      'scripts/enterprise/upstream-rebase-ci/gates.ts',
      'scripts/enterprise/rebase-report.ts',
    ]);
    expect(existing).toContain('src/app/feature.ts');
  });

  it('detects autofix worktree mutation after exit 0', async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'autofix-'));
    temporaryRoots.push(repositoryRoot);
    await runGit(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
    await runGit(repositoryRoot, 'config', 'user.email', 'autofix@example.invalid');
    await runGit(repositoryRoot, 'config', 'user.name', 'Autofix Test');
    await writeRepoFile(repositoryRoot, 'a.ts', 'export const a = 1;\n');
    await commitAll(repositoryRoot, 'base');
    await writeRepoFile(repositoryRoot, 'a.ts', 'export const a = 2;\n');
    expect(await detectAutofixMutation(repositoryRoot)).toBe(true);
  });
});

describe('evidence contract', () => {
  it('requires verified freshness and rejects fail-closed outcome as non-passing', () => {
    const gates = [
      {
        id: 'bun-check-changed',
        kind: 'command' as const,
        outcome: 'passed' as const,
        reason: 'lint',
      },
      {
        id: 'privacy-review',
        kind: 'privacy-scan' as const,
        outcome: 'passed' as const,
        reason: 'privacy',
      },
      {
        id: 'type-check',
        kind: 'command' as const,
        outcome: 'passed' as const,
        reason: 'types',
      },
    ];

    const evidence = createUpstreamRebaseEvidence({
      analysis: {
        mode: 'dry-run-evidence',
        networkAccess: 'ci-fetch-only',
        productionRebase: false,
        push: false,
        worktreeMutation: 'isolated-temp-only',
      },
      cleanupResult: 'passed',
      commits: {
        base: SHORT,
        candidate: SHORT,
        mergeBase: SHORT,
        upstream: SHORT,
      },
      gates,
      lane: UPSTREAM_REBASE_CI_LANE,
      reportStatus: 'clean',
      requiredGateIds: ['bun-check-changed', 'privacy-review', 'type-check'],
      schemaVersion: UPSTREAM_REBASE_CI_SCHEMA_VERSION,
      summary: {
        candidateChangedPaths: 1,
        conflicts: 0,
        directModificationHotspots: 0,
        patchDrift: 0,
        upstreamChangedPaths: 1,
      },
      upstream: {
        freshness: 'verified-by-ci-fetch',
        ref: 'main',
        repository: 'lobehub/lobehub',
        sha: FULL_SHA,
      },
    });
    expect(isPassingUpstreamRebaseEvidence(evidence)).toBe(true);
    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        upstream: { ...evidence.upstream, freshness: 'unverified' },
      }),
    ).toBe(false);
  });
});

describe('enterprise-upstream-rebase workflow', () => {
  it('is read-only dry-run with integration-tree gates and pinned actions', async () => {
    const source = await readFile(WORKFLOW_PATH, 'utf8');
    const workflow = parse(source) as {
      concurrency: { 'cancel-in-progress': boolean; 'group': string };
      jobs: Record<
        string,
        {
          'if'?: string;
          'steps': Array<Record<string, unknown>>;
          'timeout-minutes'?: number;
        }
      >;
      on: Record<string, unknown>;
      permissions: Record<string, string>;
    };

    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on).toHaveProperty('schedule');

    const job = workflow.jobs['dry-run'];
    expect(job['timeout-minutes']).toBe(90);
    const uses = job.steps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === 'string');
    expect(uses).toContain('actions/checkout@v6');
    expect(uses).toContain('actions/upload-artifact@v6');

    const joined = extractRunBlocks(source).join('\n');
    expect(joined).toContain('integrationRepository');
    expect(joined).toContain('UPSTREAM_REBASE_INTEGRATION_REPO');
    expect(joined).toContain('run-gates');
    expect(joined).toContain('changed-paths');
    expect(joined).toContain('UPSTREAM_REBASE_SOURCE_HEAD');
    expect(joined).not.toMatch(/\bgit\s+push\b/u);
    expect(joined).not.toContain('GITHUB_TOKEN');
    expect(joined).toMatch(/rm_code=\$\?/);

    // Gates must not run against GITHUB_WORKSPACE as the integration repo.
    expect(joined).toContain('--repo "$UPSTREAM_REBASE_INTEGRATION_REPO"');
    expect(joined).not.toMatch(
      /run-gates \\[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*--repo "\$GITHUB_WORKSPACE"/u,
    );

    const syncSource = await readFile(SYNC_WORKFLOW_PATH, 'utf8');
    expect(syncSource).toContain('Fork-Sync-With-Upstream-action');
    expect(source).not.toContain('Fork-Sync-With-Upstream-action');
    expect(source).not.toContain('contents: write');
  });

  it('documents actionlint unavailability when the binary is missing', async () => {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      expect(probe.error?.message ?? probe.stderr ?? 'actionlint unavailable').toMatch(
        /actionlint|ENOENT|not found|unavailable/i,
      );
      return;
    }
    const lint = spawnSync('actionlint', [WORKFLOW_PATH], { encoding: 'utf8' });
    expect(lint.status).toBe(0);
  });
});
