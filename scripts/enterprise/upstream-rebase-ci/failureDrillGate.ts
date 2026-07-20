import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createFailureDrillEvidence,
  FAILURE_DRILL_LANE,
  FAILURE_DRILL_SCHEMA_VERSION,
  type FailureDrillEvidence,
} from '../failure-drills/contract';
import { verifyFailureDrillEvidence } from '../failure-drills/runner';
import { FAILURE_DRILL_SCENARIOS } from '../failure-drills/scenarios';
import type { GateResult } from './contract';
import { runProcess } from './process';

export interface FailureDrillReadiness {
  ok: boolean;
  reason: string;
}

/**
 * Real drills need owned disposable PostgreSQL + Redis (as in enterprise-failure-drills.yml).
 * Contract/unit suites alone are never readiness.
 */
export const assessFailureDrillReadiness = (
  env: NodeJS.ProcessEnv = process.env,
): FailureDrillReadiness => {
  if (env.TEST_SERVER_DB !== '1') {
    return {
      ok: false,
      reason: 'TEST_SERVER_DB=1 is required for real multi-connection PG drills',
    };
  }
  if (!env.DATABASE_TEST_URL || !/^postgres(?:ql)?:\/\//u.test(env.DATABASE_TEST_URL)) {
    return {
      ok: false,
      reason: 'DATABASE_TEST_URL must point at an owned disposable PostgreSQL database',
    };
  }
  if (!env.TEST_REDIS_URL || !/^rediss?:\/\//u.test(env.TEST_REDIS_URL)) {
    return {
      ok: false,
      reason: 'TEST_REDIS_URL must point at an owned disposable Redis database',
    };
  }
  // Refuse obviously shared/production-looking host names in the URL strings without logging them.
  const combined = `${env.DATABASE_TEST_URL}\0${env.TEST_REDIS_URL}`.toLowerCase();
  if (
    combined.includes('prod') ||
    combined.includes('neon.tech') ||
    combined.includes('amazonaws.com')
  ) {
    return {
      ok: false,
      reason: 'Refusing non-disposable-looking database endpoints for dry-run drills',
    };
  }
  return { ok: true, reason: 'owned PostgreSQL and Redis endpoints configured' };
};

export const buildPassingFailureDrillEvidenceFixture = (
  gitSha = 'a'.repeat(40),
): FailureDrillEvidence[] =>
  FAILURE_DRILL_SCENARIOS.map((scenario) => {
    const expected = scenario.reports.reduce(
      (total, report) => total + report.expectedAssertions,
      0,
    );
    return createFailureDrillEvidence({
      artifact: { sha256: 'b'.repeat(64) },
      assertions: { failed: 0, passed: expected, skipped: 0, total: expected },
      cleanupResult: 'passed',
      dependencies: {
        bun: '1.3.5',
        node: '24.13.0',
        postgres: '17.5',
        redis: '7.4.2',
      },
      elapsed: { milliseconds: 25 },
      gitSha,
      injection: scenario.injection,
      lane: FAILURE_DRILL_LANE,
      recovery: scenario.recovery,
      scenarioId: scenario.scenarioId,
      schemaVersion: FAILURE_DRILL_SCHEMA_VERSION,
    });
  });

export const writeFailureDrillEvidenceFixture = async (
  outputDirectory: string,
  records: FailureDrillEvidence[],
) => {
  await mkdir(outputDirectory, { recursive: true });
  for (const evidence of records) {
    await writeFile(
      path.join(outputDirectory, `${evidence.scenarioId}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
  }
};

/**
 * Accept only full multi-scenario redacted evidence that passes the reviewed verifier.
 * Unit/contract test outputs alone cannot satisfy this.
 */
export const evaluateFailureDrillEvidenceDirectory = async (
  outputDirectory: string,
): Promise<boolean> => {
  try {
    return await verifyFailureDrillEvidence(outputDirectory);
  } catch {
    return false;
  }
};

const pathExists = async (absolutePath: string) => {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

/** Vitest invocations matching enterprise-failure-drills.yml (owned env only). */
const DRILL_COMMANDS: Array<{ cwd?: string; output: string; args: string[] }> = [
  {
    output: 'postgres-agent-materialization.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/services/agentCatalog/materialization.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-agent-rollout.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/services/agentCatalog/rolloutService.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-identity-attempt.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/services/identityProvider/testAttemptStore.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-secret-rewrap.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/services/secretRewrap/worker.multiconn.pg.test.ts',
    ],
  },
  {
    cwd: 'packages/database',
    output: 'postgres-platform-instance.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.server.mts',
      '--silent=passed-only',
      '--hookTimeout=60000',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'src/repositories/platformInstance/index.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'identity-convergence.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/services/identityProvider/convergence.pg.test.ts',
    ],
  },
  {
    output: 'identity-startup-lock-release.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      '--testNamePattern',
      'releases the cross-instance advisory lock when the owning PG connection crashes',
      'apps/server/src/enterprise/services/identityProvider/startupSnapshot.test.ts',
    ],
  },
  {
    output: 'redis-database-rebuild.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=60000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=60000',
      '--outputFile',
      '__OUT__',
      '--testNamePattern',
      'converges through request-time version reads across two independent clients',
      'apps/server/src/enterprise/runtimeConfig/domainCache.redis.integration.test.ts',
    ],
  },
];

export interface FailureDrillGateOptions {
  /**
   * Test seam: skip process execution and only verify an evidence directory.
   */
  injectedEvidenceDirectory?: string;
  rawDirectory: string;
  repositoryRoot: string;
}

/**
 * failure-drills gate for dry-run CI.
 * Runs the reviewed multi-suite drill path when disposable PG/Redis are available,
 * then requires scripts/enterprise/failure-drills collect/verify evidence.
 * Unit/contract suites alone never pass this gate.
 */
export const runFailureDrillsGate = async ({
  injectedEvidenceDirectory,
  rawDirectory,
  repositoryRoot,
}: FailureDrillGateOptions): Promise<GateResult> => {
  const runnerEntry = path.join(repositoryRoot, 'scripts/enterprise/failure-drills/index.ts');
  if (!(await pathExists(runnerEntry))) {
    return {
      id: 'failure-drills',
      kind: 'command',
      outcome: 'failed',
      reason: 'failure-drills runner is absent; gate fails closed.',
    };
  }

  if (injectedEvidenceDirectory) {
    const verified = await evaluateFailureDrillEvidenceDirectory(injectedEvidenceDirectory);
    if (!verified) {
      return {
        id: 'failure-drills',
        kind: 'command',
        outcome: 'failed',
        reason:
          'Injected failure-drill evidence failed strict multi-scenario verify (unit-only fakes rejected).',
      };
    }
    return {
      assertions: {
        failed: 0,
        passed: FAILURE_DRILL_SCENARIOS.length,
        skipped: 0,
        total: FAILURE_DRILL_SCENARIOS.length,
      },
      id: 'failure-drills',
      kind: 'command',
      outcome: 'passed',
      reason: 'Structured multi-scenario failure-drill evidence verified.',
    };
  }

  const readiness = assessFailureDrillReadiness();
  if (!readiness.ok) {
    return {
      id: 'failure-drills',
      kind: 'command',
      outcome: 'failed',
      reason: `Failure drills unavailable in this environment: ${readiness.reason}`,
    };
  }

  const reportsDirectory = path.join(rawDirectory, 'failure-drill-vitest');
  const evidenceDirectory = path.join(rawDirectory, 'failure-drill-evidence');
  await mkdir(reportsDirectory, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });

  let suiteFailed = false;
  for (const command of DRILL_COMMANDS) {
    const outputPath = path.join(reportsDirectory, command.output);
    const argv = command.args.map((argument) => (argument === '__OUT__' ? outputPath : argument));
    const cwd = command.cwd ? path.join(repositoryRoot, command.cwd) : repositoryRoot;
    const result = await runProcess(argv, cwd);
    if (result.code !== 0) suiteFailed = true;
  }

  const headResult = await runProcess(['git', 'rev-parse', 'HEAD'], repositoryRoot);
  const gitSha = /^[a-f\d]{40}$/u.test(headResult.stdout.trim())
    ? headResult.stdout.trim()
    : '0'.repeat(40);

  // Always attempt collect so missing/partial reports fail closed via the reviewed runner.
  const collect = await runProcess(
    [
      'bun',
      'scripts/enterprise/failure-drills/index.ts',
      'collect',
      '--bun-version',
      process.env.BUN_VERSION || '1.0.0',
      '--cleanup-result',
      suiteFailed ? 'failed' : 'passed',
      '--git-sha',
      gitSha,
      '--node-version',
      process.versions.node.replace(/^v/u, ''),
      '--output-dir',
      evidenceDirectory,
      '--postgres-version',
      '17.0',
      '--redis-version',
      '7.0.0',
      '--reports-dir',
      reportsDirectory,
    ],
    repositoryRoot,
  );

  const verified = await evaluateFailureDrillEvidenceDirectory(evidenceDirectory);
  if (collect.code !== 0 || suiteFailed || !verified) {
    return {
      id: 'failure-drills',
      kind: 'command',
      outcome: 'failed',
      reason:
        'Real failure-drill suites or structured evidence verification failed (unit tests cannot pass this gate).',
    };
  }

  return {
    assertions: {
      failed: 0,
      passed: FAILURE_DRILL_SCENARIOS.length,
      skipped: 0,
      total: FAILURE_DRILL_SCENARIOS.length,
    },
    id: 'failure-drills',
    kind: 'command',
    outcome: 'passed',
    reason: 'Real multi-connection PG/Redis drill evidence collected and verified.',
  };
};
