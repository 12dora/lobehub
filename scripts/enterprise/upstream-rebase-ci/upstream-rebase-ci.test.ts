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
  STRUCTURED_COMMAND_GATE_IDS,
  UPSTREAM_REBASE_CI_LANE,
  UPSTREAM_REBASE_CI_SCHEMA_VERSION,
} from './contract';
import {
  assessFailureDrillReadiness,
  buildPassingFailureDrillEvidenceFixture,
  evaluateFailureDrillEvidenceDirectory,
  runFailureDrillsGate,
  writeFailureDrillEvidenceFixture,
} from './failureDrillGate';
import {
  assertSourceUnchanged,
  captureSourceSnapshot,
  digestPorcelainStatus,
  materializeIntegrationTree,
} from './fetchUpstream';
import {
  detectAutofixMutation,
  GATE_DEFINITIONS,
  resolveGateDefinition,
  selectBunCheckPaths,
  VITEST_OUTPUT_PLACEHOLDER,
} from './gates';
import {
  buildQ03PassingFixtureReport,
  evaluateQ03MigrationCompatEvidence,
  runMigrationUpgradeRollbackGate,
} from './migrationGate';
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
    expect(GATE_DEFINITIONS['failure-drills'].kind).toBe('command');
    expect(GATE_DEFINITIONS['failure-drills'].runner).toBe('failure-drills');
    expect(GATE_DEFINITIONS['failure-drills'].failClosed).toBeUndefined();
    expect(GATE_DEFINITIONS['bun-check-changed'].runner).toBe('bun-check-changed');
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].kind).toBe('command');
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].runner).toBe(
      'migration-upgrade-rollback',
    );
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].reason).toMatch(/Q03/);
    expect(GATE_DEFINITIONS['migration-upgrade-rollback'].reason).toMatch(
      /weak journal-only substitutes are rejected/i,
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
            assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
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
    ).toThrow(/assertions/);

    expect(() =>
      parseGateResultsStrict(
        [
          {
            id: 'bun-check-changed',
            kind: 'command',
            outcome: 'passed',
            reason: 'ok',
            assertions: { failed: 0, passed: 0, skipped: 0, total: 0 },
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
    ).toThrow(/positive all-pass|assertions/);

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

describe('migration-upgrade-rollback Q03-only', () => {
  it('fails closed when Q03 verifier is absent (no journal fallback)', async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'migration-absent-'));
    temporaryRoots.push(repositoryRoot);
    const result = await runMigrationUpgradeRollbackGate({
      rawDirectory: path.join(repositoryRoot, 'raw'),
      repositoryRoot,
    });
    expect(result.outcome).toBe('failed');
    expect(result.kind).toBe('command');
    expect(result.reason).toMatch(/absent|fails closed/i);
    expect(result.reason).toMatch(/without a weak substitute/i);
  });

  it('passes only with strict Q03 synthetic foundation evidence', async () => {
    const fixture = buildQ03PassingFixtureReport();
    expect(evaluateQ03MigrationCompatEvidence(fixture)).toBe(true);
    expect(
      evaluateQ03MigrationCompatEvidence({
        ...fixture,
        syntheticResult: 'failed',
        overall: 'failed',
      }),
    ).toBe(false);
    expect(
      evaluateQ03MigrationCompatEvidence({
        ...fixture,
        overall: 'passed',
      }),
    ).toBe(false);
    expect(
      evaluateQ03MigrationCompatEvidence({
        ...fixture,
        rerun: { mode: 'idempotent', result: 'skipped' },
      }),
    ).toBe(false);

    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'migration-fixture-'));
    temporaryRoots.push(repositoryRoot);
    const result = await runMigrationUpgradeRollbackGate({
      injectedReport: fixture,
      rawDirectory: path.join(repositoryRoot, 'raw'),
      repositoryRoot,
    });
    expect(result.outcome).toBe('passed');
    expect(result.assertions?.total).toBeGreaterThan(0);
    expect(result.assertions?.passed).toBe(result.assertions?.total);
    expect(result.reason).toMatch(/Q03|synthetic foundation/i);
    expect(result.reason).not.toMatch(/app-version rollback|overall pass/i);
  });
});

describe('failure-drills structured evidence', () => {
  it('rejects unit-only / incomplete evidence and accepts multi-scenario fixtures', async () => {
    const incompleteDir = await mkdtemp(path.join(tmpdir(), 'drill-incomplete-'));
    temporaryRoots.push(incompleteDir);
    await writeFile(
      path.join(incompleteDir, 'not-a-scenario.json'),
      `${JSON.stringify({ lane: 'enterprise-failure-drills' })}\n`,
      'utf8',
    );
    expect(await evaluateFailureDrillEvidenceDirectory(incompleteDir)).toBe(false);

    const emptyDir = await mkdtemp(path.join(tmpdir(), 'drill-empty-'));
    temporaryRoots.push(emptyDir);
    expect(await evaluateFailureDrillEvidenceDirectory(emptyDir)).toBe(false);

    const fullDir = await mkdtemp(path.join(tmpdir(), 'drill-full-'));
    temporaryRoots.push(fullDir);
    await writeFailureDrillEvidenceFixture(fullDir, buildPassingFailureDrillEvidenceFixture());
    expect(await evaluateFailureDrillEvidenceDirectory(fullDir)).toBe(true);

    const gatePass = await runFailureDrillsGate({
      injectedEvidenceDirectory: fullDir,
      rawDirectory: path.join(fullDir, 'raw'),
      repositoryRoot: process.cwd(),
    });
    expect(gatePass.outcome).toBe('passed');
    expect(gatePass.assertions?.total).toBeGreaterThan(0);

    const gateFail = await runFailureDrillsGate({
      injectedEvidenceDirectory: incompleteDir,
      rawDirectory: path.join(incompleteDir, 'raw'),
      repositoryRoot: process.cwd(),
    });
    expect(gateFail.outcome).toBe('failed');
    expect(gateFail.reason).toMatch(/unit-only|verify|failed/i);
  });

  it('reports unavailable/failed when disposable PG/Redis are not configured', async () => {
    const readiness = assessFailureDrillReadiness({
      ...process.env,
      DATABASE_TEST_URL: undefined,
      TEST_REDIS_URL: undefined,
      TEST_SERVER_DB: undefined,
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toMatch(/TEST_SERVER_DB|DATABASE_TEST_URL|TEST_REDIS_URL/i);

    const previous = {
      DATABASE_TEST_URL: process.env.DATABASE_TEST_URL,
      TEST_REDIS_URL: process.env.TEST_REDIS_URL,
      TEST_SERVER_DB: process.env.TEST_SERVER_DB,
    };
    delete process.env.DATABASE_TEST_URL;
    delete process.env.TEST_REDIS_URL;
    delete process.env.TEST_SERVER_DB;
    try {
      const result = await runFailureDrillsGate({
        rawDirectory: path.join(tmpdir(), `drill-unavail-${Date.now()}`),
        repositoryRoot: process.cwd(),
      });
      expect(result.outcome).toBe('failed');
      expect(result.reason).toMatch(/unavailable|required/i);
    } finally {
      if (previous.DATABASE_TEST_URL) process.env.DATABASE_TEST_URL = previous.DATABASE_TEST_URL;
      if (previous.TEST_REDIS_URL) process.env.TEST_REDIS_URL = previous.TEST_REDIS_URL;
      if (previous.TEST_SERVER_DB) process.env.TEST_SERVER_DB = previous.TEST_SERVER_DB;
    }
  });
});

describe('evidence contract', () => {
  const baseEvidenceInput = () => ({
    analysis: {
      mode: 'dry-run-evidence' as const,
      networkAccess: 'ci-fetch-only' as const,
      productionRebase: false as const,
      push: false as const,
      worktreeMutation: 'isolated-temp-only' as const,
    },
    cleanupResult: 'passed' as const,
    commits: {
      base: SHORT,
      candidate: SHORT,
      mergeBase: SHORT,
      upstream: SHORT,
    },
    gates: [
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
    ],
    lane: UPSTREAM_REBASE_CI_LANE,
    reportStatus: 'clean' as const,
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
      freshness: 'verified-by-ci-fetch' as const,
      ref: 'main',
      repository: 'lobehub/lobehub',
      sha: FULL_SHA,
    },
  });

  it('requires verified freshness and rejects fail-closed outcome as non-passing', () => {
    const evidence = createUpstreamRebaseEvidence(baseEvidenceInput());
    expect(isPassingUpstreamRebaseEvidence(evidence)).toBe(true);
    expect(
      isPassingUpstreamRebaseEvidence({
        ...evidence,
        upstream: { ...evidence.upstream, freshness: 'unverified' },
      }),
    ).toBe(false);
  });

  it('rejects duplicate required ids and duplicate gate results at the final evidence layer', () => {
    expect(() =>
      createUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: [
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'a',
          },
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'b',
          },
        ],
        requiredGateIds: ['type-check', 'type-check'],
      }),
    ).toThrow(/unique|exactly match/i);

    expect(
      isPassingUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: [
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'a',
          },
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'b',
          },
        ],
        requiredGateIds: ['type-check', 'type-check'],
        redactionScan: { result: 'passed', violations: 0 },
      }),
    ).toBe(false);
  });

  it('rejects extra, missing, and wrong-kind gates at the final evidence layer', () => {
    expect(() =>
      createUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: [
          ...baseEvidenceInput().gates,
          {
            id: 'spa-route-sync',
            kind: 'vitest',
            outcome: 'passed',
            reason: 'extra',
            assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
          },
        ],
      }),
    ).toThrow(/exactly match|length/i);

    expect(() =>
      createUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: baseEvidenceInput().gates.slice(0, 2),
      }),
    ).toThrow(/exactly match|length/i);

    expect(() =>
      createUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: [
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
            reason: 'privacy',
          },
          {
            id: 'type-check',
            kind: 'command',
            outcome: 'passed',
            reason: 'types',
          },
        ],
      }),
    ).toThrow(/kind/i);

    expect(() =>
      createUpstreamRebaseEvidence({
        ...baseEvidenceInput(),
        gates: [
          {
            id: 'manual-conflict-review',
            kind: 'fail-closed',
            outcome: 'passed',
            reason: 'must not pass',
          },
        ],
        requiredGateIds: ['manual-conflict-review'],
      }),
    ).toThrow(/cannot pass|fail-closed/i);
  });

  it('requires assertions for structured command gates on pass and fail', () => {
    expect(STRUCTURED_COMMAND_GATE_IDS.has('migration-upgrade-rollback')).toBe(true);
    expect(STRUCTURED_COMMAND_GATE_IDS.has('failure-drills')).toBe(true);

    for (const id of ['migration-upgrade-rollback', 'failure-drills'] as const) {
      expect(() =>
        createUpstreamRebaseEvidence({
          ...baseEvidenceInput(),
          gates: [
            {
              id,
              kind: 'command',
              outcome: 'passed',
              reason: 'missing assertions',
            },
          ],
          requiredGateIds: [id],
        }),
      ).toThrow(/assertions/i);

      expect(() =>
        createUpstreamRebaseEvidence({
          ...baseEvidenceInput(),
          gates: [
            {
              id,
              kind: 'command',
              outcome: 'failed',
              reason: 'missing assertions',
            },
          ],
          requiredGateIds: [id],
        }),
      ).toThrow(/assertions/i);

      expect(() =>
        parseGateResultsStrict(
          [
            {
              id,
              kind: 'command',
              outcome: 'failed',
              reason: 'contradictory all-pass on failed',
              assertions: { failed: 0, passed: 2, skipped: 0, total: 2 },
            },
          ],
          [id],
        ),
      ).toThrow(/all-pass|assertions/i);
    }
  });
});

describe('source immutability snapshot', () => {
  it('rejects initially dirty worktrees and equal-length different porcelain content', async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'source-immut-'));
    temporaryRoots.push(repositoryRoot);
    await runGit(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
    await runGit(repositoryRoot, 'config', 'user.email', 'immut@example.invalid');
    await runGit(repositoryRoot, 'config', 'user.name', 'Immut Test');
    await writeRepoFile(repositoryRoot, 'a.ts', 'export const a = 1;\n');
    await commitAll(repositoryRoot, 'base');

    const clean = await captureSourceSnapshot(repositoryRoot);
    expect(clean.statusDigest).toBe(digestPorcelainStatus(''));
    await assertSourceUnchanged(repositoryRoot, clean);

    await writeRepoFile(repositoryRoot, 'a.ts', 'export const a = 2;\n');
    await expect(captureSourceSnapshot(repositoryRoot)).rejects.toThrow(/must be clean/i);

    // Equal-length different porcelain content must change the digest (not length equality).
    const left = ' M a.ts\0';
    const right = ' M b.ts\0';
    expect(left.length).toBe(right.length);
    expect(digestPorcelainStatus(left)).not.toBe(digestPorcelainStatus(right));

    await writeRepoFile(repositoryRoot, 'b.ts', 'export const b = 1;\n');
    // Dirty with two modified files still cannot capture.
    await expect(captureSourceSnapshot(repositoryRoot)).rejects.toThrow(/must be clean/i);
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
    expect(joined).toContain('snapshot-source');
    expect(joined).toContain('assert-source-unchanged');
    expect(joined).toContain('statusDigest');
    expect(joined).not.toMatch(/\bwc\s+-c\b/u);
    expect(joined).not.toContain('UPSTREAM_REBASE_SOURCE_STATUS_BYTES');
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
