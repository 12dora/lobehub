import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { filterExistingLintablePaths } from './changedFiles';
import type { GateResult, KnownGateId } from './contract';
import { EXPECTED_GATE_KINDS, FAIL_CLOSED_GATE_IDS, KNOWN_GATE_IDS } from './contract';
import { assertNoSecrets } from './secretScan';

/** Placeholder replaced at runtime with an absolute path under the run raw dir. */
export const VITEST_OUTPUT_PLACEHOLDER = '__UPSTREAM_REBASE_GATE_OUTPUT__' as const;

export interface GateDefinition {
  argv?: string[];
  cwd?: string;
  failClosed?: boolean;
  id: KnownGateId;
  kind: GateResult['kind'];
  minPassed?: number;
  reason: string;
  /**
   * Built-in custom runners that need changed-file context or multi-suite logic.
   */
  runner?: 'bun-check-changed' | 'migration-upgrade-rollback';
}

/**
 * Deterministic mapping from rebase-report required gates to local commands.
 * Missing mappings must fail closed — never pass via skip.
 */
export const GATE_DEFINITIONS: Record<KnownGateId, GateDefinition> = {
  'auth-e2e': {
    id: 'auth-e2e',
    kind: 'vitest',
    minPassed: 1,
    reason: 'Focused Better Auth / OIDC unit gates (full browser e2e remains separate).',
    argv: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      VITEST_OUTPUT_PLACEHOLDER,
      'src/libs/better-auth/sso/platformIdentityProvider.secureProfile.test.ts',
      'src/app/(backend)/api/auth/[...all]/route.test.ts',
      'apps/server/src/enterprise/guards/reauth.test.ts',
    ],
  },
  'bun-check-changed': {
    id: 'bun-check-changed',
    kind: 'command',
    runner: 'bun-check-changed',
    reason: 'Lint and focused tests on the real base/upstream/candidate changed-file set.',
  },
  'desktop-release': {
    id: 'desktop-release',
    kind: 'vitest',
    minPassed: 1,
    reason: 'Desktop branding/release workflow static gates.',
    argv: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      VITEST_OUTPUT_PLACEHOLDER,
      'tests/electronWorkflow/desktopBrandingWorkflow.test.ts',
    ],
  },
  'failure-drills': {
    id: 'failure-drills',
    kind: 'fail-closed',
    failClosed: true,
    reason:
      'Real PostgreSQL/Redis failure drills require enterprise-failure-drills.yml; contract unit tests cannot pass this gate.',
  },
  'manual-conflict-review': {
    id: 'manual-conflict-review',
    kind: 'fail-closed',
    failClosed: true,
    reason: 'Conflicts require independent manual review; dry-run cannot auto-pass.',
  },
  'migration-upgrade-rollback': {
    id: 'migration-upgrade-rollback',
    kind: 'vitest',
    runner: 'migration-upgrade-rollback',
    minPassed: 1,
    reason:
      'Journal integrity plus platform Migration-0 schema gate (Q03 verify-migration when present on trunk).',
  },
  'patch-ledger-update': {
    id: 'patch-ledger-update',
    kind: 'fail-closed',
    failClosed: true,
    reason: 'Patch drift requires ledger updates; dry-run cannot auto-pass.',
  },
  'permission-matrix': {
    id: 'permission-matrix',
    kind: 'vitest',
    minPassed: 1,
    reason: 'Admin procedure permission matrix regression.',
    argv: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      VITEST_OUTPUT_PLACEHOLDER,
      'apps/server/src/enterprise/routers/permissionMatrix.test.ts',
    ],
  },
  'privacy-review': {
    id: 'privacy-review',
    kind: 'privacy-scan',
    reason: 'Raw report and redacted evidence must remain secret-free.',
  },
  'spa-route-sync': {
    id: 'spa-route-sync',
    kind: 'vitest',
    minPassed: 1,
    reason: 'Desktop SPA route tree sync gate.',
    argv: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      VITEST_OUTPUT_PLACEHOLDER,
      'src/spa/router/desktopRouter.sync.test.tsx',
    ],
  },
  'type-check': {
    id: 'type-check',
    kind: 'command',
    reason: 'Full repository type-check on the integrated candidate+upstream tree.',
    argv: ['bun', 'run', 'type-check'],
  },
};

// Keep kinds aligned with the shared contract map used by strict schemas.
for (const id of KNOWN_GATE_IDS) {
  if (GATE_DEFINITIONS[id].kind !== EXPECTED_GATE_KINDS[id]) {
    throw new Error(`Gate kind drift for ${id}`);
  }
  if (FAIL_CLOSED_GATE_IDS.has(id) && !GATE_DEFINITIONS[id].failClosed) {
    throw new Error(`Fail-closed gate ${id} missing failClosed flag`);
  }
}

export const resolveGateDefinition = (gateId: string): GateDefinition => {
  if (!(KNOWN_GATE_IDS as readonly string[]).includes(gateId)) {
    return {
      id: gateId as KnownGateId,
      kind: 'fail-closed',
      failClosed: true,
      reason: `Unknown required gate "${gateId}" has no deterministic mapping.`,
    };
  }
  return GATE_DEFINITIONS[gateId as KnownGateId];
};

interface ProcessResult {
  code: number;
  stderr: string;
  stdout: string;
}

export const runProcess = (argv: string[], cwd: string): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error('Gate command is empty'));
      return;
    }
    const child = spawn(command, args, {
      cwd,
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

interface VitestJsonReport {
  numFailedTests?: number;
  numPassedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numTotalTests?: number;
  success?: boolean;
}

const readVitestAssertions = async (reportPath: string) => {
  let raw: string;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch {
    throw new Error(`Gate report missing: ${path.basename(reportPath)}`);
  }

  let report: VitestJsonReport;
  try {
    report = JSON.parse(raw) as VitestJsonReport;
  } catch {
    throw new Error(`Gate report is not valid JSON: ${path.basename(reportPath)}`);
  }

  const failed = report.numFailedTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  const total = report.numTotalTests ?? failed + passed + skipped;

  return {
    failed,
    passed,
    skipped,
    success: report.success === true,
    total,
  };
};

const evaluateVitestAssertions = (
  assertions: Awaited<ReturnType<typeof readVitestAssertions>>,
  processCode: number,
  minPassed: number,
) =>
  processCode === 0 &&
  assertions.success &&
  assertions.total > 0 &&
  assertions.passed >= minPassed &&
  assertions.passed === assertions.total &&
  assertions.failed === 0 &&
  assertions.skipped === 0
    ? ('passed' as const)
    : ('failed' as const);

/**
 * After autofixing checkers, any worktree mutation is a false green.
 */
export const detectAutofixMutation = async (repositoryRoot: string): Promise<boolean> => {
  const status = await runProcess(
    ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    repositoryRoot,
  );
  return status.code === 0 && status.stdout.length > 0;
};

export const runBunCheckChangedGate = async ({
  changedPaths,
  repositoryRoot,
}: {
  changedPaths: string[];
  repositoryRoot: string;
}): Promise<GateResult> => {
  const files = await filterExistingLintablePaths(repositoryRoot, changedPaths);
  if (files.length === 0) {
    return {
      id: 'bun-check-changed',
      kind: 'command',
      outcome: 'failed',
      reason: 'No existing lintable changed files in the integration tree.',
    };
  }

  // Cap argv size while keeping determinism: sort already applied; take full set if reasonable.
  const selected = files.length > 400 ? files.slice(0, 400) : files;
  if (files.length > 400) {
    // Still fail closed if we had to truncate — partial coverage is not a pass.
    return {
      id: 'bun-check-changed',
      kind: 'command',
      outcome: 'failed',
      reason: `Changed-file set too large for single gate invocation (${files.length}).`,
    };
  }

  const processResult = await runProcess(
    ['bun', 'run', 'check', '--lint', '--test', ...selected],
    repositoryRoot,
  );

  if (processResult.code !== 0) {
    return {
      id: 'bun-check-changed',
      kind: 'command',
      outcome: 'failed',
      reason: 'Changed-file lint/focused-test gate failed.',
    };
  }

  if (await detectAutofixMutation(repositoryRoot)) {
    return {
      id: 'bun-check-changed',
      kind: 'command',
      outcome: 'failed',
      reason: 'Autofix mutated the integration tree after exit 0 (false green).',
    };
  }

  return {
    id: 'bun-check-changed',
    kind: 'command',
    outcome: 'passed',
    reason: `Lint/focused tests on ${selected.length} changed path(s).`,
  };
};

/** Pure helper used by tests to prove non-orchestration paths are retained. */
export const selectBunCheckPaths = (existingLintablePaths: string[]): string[] => {
  if (existingLintablePaths.length === 0) return [];
  if (existingLintablePaths.length > 400) {
    throw new Error(
      `Changed-file set too large for single gate invocation (${existingLintablePaths.length}).`,
    );
  }
  return existingLintablePaths;
};

export const runMigrationUpgradeRollbackGate = async ({
  rawDirectory,
  repositoryRoot,
}: {
  rawDirectory: string;
  repositoryRoot: string;
}): Promise<GateResult> => {
  const outputFile = path.join(rawDirectory, 'gate-migration-upgrade-rollback.json');
  await mkdir(rawDirectory, { recursive: true });
  await rm(outputFile, { force: true });

  // Prefer Q03 verifier when present on the tree; otherwise equivalent journal + migration-0 gate.
  const q03Entry = path.join(repositoryRoot, 'scripts/enterprise/verify-migration.ts');
  let processResult: ProcessResult;
  try {
    await readFile(q03Entry, 'utf8');
    processResult = await runProcess(
      ['bun', 'scripts/enterprise/verify-migration.ts', '--repo-root', repositoryRoot],
      repositoryRoot,
    );
    if (processResult.code !== 0) {
      return {
        assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
        id: 'migration-upgrade-rollback',
        kind: 'vitest',
        outcome: 'failed',
        reason: 'Q03 migration compatibility verifier failed.',
      };
    }
    return {
      assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
      id: 'migration-upgrade-rollback',
      kind: 'vitest',
      outcome: 'passed',
      reason: 'Q03 migration compatibility verifier passed with structured success.',
    };
  } catch {
    // fall through to equivalent local gates
  }

  // Root vitest excludes packages/**. Use the database package config.
  processResult = await runProcess(
    [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      outputFile,
      'src/models/__tests__/migrationJournal.meta.test.ts',
      'src/models/__tests__/platformSchema.migration.test.ts',
    ],
    path.join(repositoryRoot, 'packages/database'),
  );

  try {
    const assertions = await readVitestAssertions(outputFile);
    const outcome = evaluateVitestAssertions(assertions, processResult.code, 2);
    return {
      assertions: {
        failed: assertions.failed,
        passed: assertions.passed,
        skipped: assertions.skipped,
        total: assertions.total,
      },
      id: 'migration-upgrade-rollback',
      kind: 'vitest',
      outcome,
      reason:
        outcome === 'passed'
          ? 'Journal integrity and platform Migration-0 schema gates passed.'
          : 'Migration upgrade/rollback equivalent gate failed, skipped, or reported zero tests.',
    };
  } catch (error) {
    return {
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      id: 'migration-upgrade-rollback',
      kind: 'vitest',
      outcome: 'failed',
      reason:
        error instanceof Error
          ? error.message.slice(0, 240)
          : 'Migration gate report could not be validated.',
    };
  }
};

export interface RunSelectedGatesOptions {
  changedPaths: string[];
  privacyTargets: unknown[];
  rawDirectory: string;
  rawReportText?: string;
  repositoryRoot: string;
  requiredGateIds: string[];
}

export const runSelectedGates = async ({
  changedPaths,
  privacyTargets,
  rawDirectory,
  rawReportText,
  repositoryRoot,
  requiredGateIds,
}: RunSelectedGatesOptions): Promise<GateResult[]> => {
  await mkdir(rawDirectory, { recursive: true });
  const results: GateResult[] = [];

  for (const gateId of requiredGateIds) {
    const definition = resolveGateDefinition(gateId);

    if (definition.failClosed || definition.kind === 'fail-closed') {
      results.push({
        id: gateId,
        kind: 'fail-closed',
        outcome: 'failed',
        reason: definition.reason,
      });
      continue;
    }

    if (definition.kind === 'privacy-scan') {
      try {
        for (const target of privacyTargets) {
          assertNoSecrets(target, 'privacy-review target');
        }
        if (rawReportText) {
          assertNoSecrets(rawReportText, 'raw rebase report');
        }
        results.push({
          id: gateId,
          kind: 'privacy-scan',
          outcome: 'passed',
          reason: definition.reason,
        });
      } catch {
        results.push({
          id: gateId,
          kind: 'privacy-scan',
          outcome: 'failed',
          reason: definition.reason,
        });
      }
      continue;
    }

    if (definition.runner === 'bun-check-changed') {
      results.push(await runBunCheckChangedGate({ changedPaths, repositoryRoot }));
      continue;
    }

    if (definition.runner === 'migration-upgrade-rollback') {
      results.push(await runMigrationUpgradeRollbackGate({ rawDirectory, repositoryRoot }));
      continue;
    }

    if (!definition.argv || definition.argv.length === 0) {
      results.push({
        id: gateId,
        kind: 'fail-closed',
        outcome: 'failed',
        reason: `Gate "${gateId}" has no executable mapping.`,
      });
      continue;
    }

    const cwd = definition.cwd
      ? path.resolve(repositoryRoot, definition.cwd)
      : path.resolve(repositoryRoot);

    const outputFile = path.join(rawDirectory, `gate-${gateId}.json`);
    if (definition.kind === 'vitest' && !definition.argv.includes(VITEST_OUTPUT_PLACEHOLDER)) {
      results.push({
        id: gateId,
        kind: 'fail-closed',
        outcome: 'failed',
        reason: `Gate "${gateId}" vitest mapping is missing output placeholder.`,
      });
      continue;
    }
    const argv = definition.argv.map((argument) =>
      argument === VITEST_OUTPUT_PLACEHOLDER ? outputFile : argument,
    );

    await mkdir(path.dirname(outputFile), { recursive: true });
    await rm(outputFile, { force: true });

    const processResult = await runProcess(argv, cwd);

    if (definition.kind === 'command') {
      let outcome: 'failed' | 'passed' = processResult.code === 0 ? 'passed' : 'failed';
      if (outcome === 'passed' && (await detectAutofixMutation(repositoryRoot))) {
        outcome = 'failed';
        results.push({
          id: gateId,
          kind: 'command',
          outcome,
          reason: 'Command gate autofix mutated the integration tree after exit 0.',
        });
        continue;
      }
      results.push({
        id: gateId,
        kind: 'command',
        outcome,
        reason: definition.reason,
      });
      continue;
    }

    try {
      const assertions = await readVitestAssertions(outputFile);
      const minPassed = definition.minPassed ?? 1;
      const outcome = evaluateVitestAssertions(assertions, processResult.code, minPassed);
      results.push({
        assertions: {
          failed: assertions.failed,
          passed: assertions.passed,
          skipped: assertions.skipped,
          total: assertions.total,
        },
        id: gateId,
        kind: 'vitest',
        outcome,
        reason: definition.reason,
      });
    } catch (error) {
      results.push({
        assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
        id: gateId,
        kind: 'vitest',
        outcome: 'failed',
        reason:
          error instanceof Error
            ? error.message.slice(0, 240)
            : 'Gate report could not be validated.',
      });
    }
  }

  return results;
};

export const writeGateResults = async (outputPath: string, results: GateResult[]) => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
};
