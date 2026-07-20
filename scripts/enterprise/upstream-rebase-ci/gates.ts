import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GateResult, KnownGateId } from './contract';
import { KNOWN_GATE_IDS, scanUpstreamRebaseEvidence } from './contract';

/** Placeholder replaced at runtime with an absolute path under the run raw dir. */
export const VITEST_OUTPUT_PLACEHOLDER = '__UPSTREAM_REBASE_GATE_OUTPUT__' as const;

export interface GateDefinition {
  /**
   * argv for a command gate. Empty for fail-closed / privacy-scan kinds that
   * do not launch an external process.
   * For vitest gates, include `--outputFile` followed by {@link VITEST_OUTPUT_PLACEHOLDER}.
   */
  argv?: string[];
  /**
   * Working directory relative to repository root (default: root).
   */
  cwd?: string;
  /**
   * When true, the gate is fail-closed without executing tests/commands.
   */
  failClosed?: boolean;
  id: KnownGateId;
  kind: GateResult['kind'];
  /**
   * Minimum required passed assertions for vitest gates.
   */
  minPassed?: number;
  /**
   * Human-readable reason recorded in evidence (never includes secrets).
   */
  reason: string;
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
    reason: 'Lint and focused tests for enterprise rebase CI sources.',
    argv: [
      'bun',
      'run',
      'check',
      '--lint',
      '--test',
      'scripts/enterprise/rebase-report.ts',
      'scripts/enterprise/upstream-rebase-ci',
    ],
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
    kind: 'vitest',
    minPassed: 1,
    reason:
      'Failure-drill contract/runner unit gates (real PG/Redis drills stay in their workflow).',
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
      'scripts/enterprise/failure-drills/runner.test.ts',
    ],
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
    minPassed: 1,
    cwd: 'packages/database',
    reason: 'Drizzle migration model regression gate (PGlite client path).',
    argv: [
      'bunx',
      'vitest',
      'run',
      '--silent=passed-only',
      '--reporter=json',
      '--outputFile',
      VITEST_OUTPUT_PLACEHOLDER,
      'src/models/__tests__/drizzleMigration.test.ts',
    ],
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
    reason: 'Redacted evidence and raw report must remain secret-free.',
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
    reason: 'Full repository type-check.',
    argv: ['bun', 'run', 'type-check'],
  },
};

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

const runProcess = (argv: string[], cwd: string): Promise<ProcessResult> =>
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

export interface RunSelectedGatesOptions {
  privacyTargets: unknown[];
  rawDirectory: string;
  repositoryRoot: string;
  requiredGateIds: string[];
}

export const runSelectedGates = async ({
  privacyTargets,
  rawDirectory,
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
      const scan = scanUpstreamRebaseEvidence(privacyTargets);
      results.push({
        id: gateId,
        kind: 'privacy-scan',
        outcome: scan.result === 'passed' && scan.violations === 0 ? 'passed' : 'failed',
        reason: definition.reason,
      });
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

    // Always write vitest JSON under the run-scoped raw directory so wipe removes it.
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
      results.push({
        id: gateId,
        kind: 'command',
        outcome: processResult.code === 0 ? 'passed' : 'failed',
        reason: definition.reason,
      });
      continue;
    }

    // vitest kind — exit code alone is insufficient; require positive pass count.
    try {
      const assertions = await readVitestAssertions(outputFile);
      const minPassed = definition.minPassed ?? 1;
      const outcome =
        processResult.code === 0 &&
        assertions.success &&
        assertions.total > 0 &&
        assertions.passed >= minPassed &&
        assertions.passed === assertions.total &&
        assertions.failed === 0 &&
        assertions.skipped === 0
          ? 'passed'
          : 'failed';

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

  // Stable order matching required gate ids
  return results;
};

export const writeGateResults = async (outputPath: string, results: GateResult[]) => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
};
