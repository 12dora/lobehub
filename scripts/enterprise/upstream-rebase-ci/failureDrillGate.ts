import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createFailureDrillEvidence,
  FAILURE_DRILL_LANE,
  FAILURE_DRILL_SCHEMA_VERSION,
  type FailureDrillEvidence,
} from '../failure-drills/contract';
import { digestFailureDrillRawReports, verifyFailureDrillEvidence } from '../failure-drills/runner';
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
  // SCE-09: three-process cluster restart drill requires an explicitly owned ephemeral Redis.
  if (env.TEST_REDIS_RESTART_OPT_IN !== '1') {
    return {
      ok: false,
      reason:
        'TEST_REDIS_RESTART_OPT_IN=1 is required for the three-process Redis restart failure drill',
    };
  }
  if (
    !env.TEST_REDIS_OWNED_CONTAINER_ID ||
    !/^[a-f0-9]{64}$/u.test(env.TEST_REDIS_OWNED_CONTAINER_ID)
  ) {
    return {
      ok: false,
      reason: 'TEST_REDIS_OWNED_CONTAINER_ID must be a full 64-char Docker container id',
    };
  }
  if (!env.TEST_REDIS_OWNERSHIP_TOKEN || !/^[a-f0-9]{32}$/u.test(env.TEST_REDIS_OWNERSHIP_TOKEN)) {
    return {
      ok: false,
      reason: 'TEST_REDIS_OWNERSHIP_TOKEN must be a 32-char hex ownership token',
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

/** Minimal Vitest JSON report body used only for digest-bound fixtures. */
const buildMinimalVitestReport = (assertionCount: number, titles?: readonly string[]): string => {
  const assertionResults = Array.from({ length: assertionCount }, (_, index) => ({
    status: 'passed' as const,
    title: titles?.[index] ?? `assertion-${index + 1}`,
  }));
  return `${JSON.stringify({
    numFailedTests: 0,
    numPassedTests: assertionCount,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: assertionCount,
    startTime: 1,
    success: true,
    testResults: [{ assertionResults, endTime: 2 }],
  })}\n`;
};

/**
 * Build digest-bound multi-scenario evidence: writes real raw report bytes and
 * aggregates whose artifact.sha256 matches recomputed digests.
 */
export const buildPassingFailureDrillEvidenceFixture = async (
  evidenceDirectory: string,
  reportsDirectory: string,
  gitSha = 'a'.repeat(40),
): Promise<FailureDrillEvidence[]> => {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(reportsDirectory, { recursive: true });

  const records: FailureDrillEvidence[] = [];
  for (const scenario of FAILURE_DRILL_SCENARIOS) {
    const reportFiles: string[] = [];
    for (const report of scenario.reports) {
      // `as const` scenario reports omit optional assertionTitles on most entries.
      const assertionTitles = 'assertionTitles' in report ? report.assertionTitles : undefined;
      const body = buildMinimalVitestReport(report.expectedAssertions, assertionTitles);
      await writeFile(path.join(reportsDirectory, report.reportFile), body, 'utf8');
      reportFiles.push(report.reportFile);
    }
    const artifactSha256 = await digestFailureDrillRawReports(reportsDirectory, reportFiles);
    const expected = scenario.reports.reduce(
      (total, report) => total + report.expectedAssertions,
      0,
    );
    const evidence = createFailureDrillEvidence({
      artifact: { sha256: artifactSha256 },
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
    await writeFile(
      path.join(evidenceDirectory, `${evidence.scenarioId}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
    records.push(evidence);
  }
  return records;
};

/**
 * Accept only full multi-scenario redacted evidence whose artifact digests match raw reports.
 * Unit/contract aggregate-only fakes without raw reports cannot satisfy this.
 */
export const evaluateFailureDrillEvidenceDirectory = async (
  outputDirectory: string,
  reportsDirectory?: string,
): Promise<boolean> => {
  try {
    return await verifyFailureDrillEvidence(outputDirectory, { reportsDirectory });
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
export const DRILL_COMMANDS: Array<{ cwd?: string; output: string; args: string[] }> = [
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
    output: 'postgres-audit-export-publication.json',
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
      'apps/server/src/enterprise/services/audit/exportPublication.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-audit-retention-lease.json',
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
      'apps/server/src/enterprise/services/audit/retentionWorker.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-audit-retention-attribution.json',
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
      'apps/server/src/enterprise/services/audit/retentionWorker.attribution.multiconn.pg.test.ts',
    ],
  },
  {
    output: 'postgres-ai-catalog-publication.json',
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
      'apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts',
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
    output: 'identity-publish-startup-lock.json',
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
      'blocks a real concurrent publish between startup recheck and LKG write',
      'apps/server/src/enterprise/services/identityProvider/publicationService.publish.test.ts',
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
  {
    output: 'redis-cluster-restart.json',
    args: [
      'bunx',
      'vitest',
      'run',
      '--config',
      'vitest.config.mts',
      '--silent=passed-only',
      '--fileParallelism=false',
      '--hookTimeout=120000',
      '--maxWorkers=1',
      '--reporter=json',
      '--testTimeout=180000',
      '--outputFile',
      '__OUT__',
      'apps/server/src/enterprise/runtimeConfig/domainCache.cluster.redis.pg.test.ts',
    ],
  },
];

export interface FailureDrillGateOptions {
  /**
   * Test seam: skip process execution and only verify an evidence directory.
   * Must be paired with injectedReportsDirectory so digests can be recomputed.
   */
  injectedEvidenceDirectory?: string;
  /** Raw Vitest report directory bound to injectedEvidenceDirectory digests. */
  injectedReportsDirectory?: string;
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
  injectedReportsDirectory,
  rawDirectory,
  repositoryRoot,
}: FailureDrillGateOptions): Promise<GateResult> => {
  const failedAssertions = {
    failed: 1,
    passed: 0,
    skipped: 0,
    total: 1,
  } as const;

  const runnerEntry = path.join(repositoryRoot, 'scripts/enterprise/failure-drills/index.ts');
  if (!(await pathExists(runnerEntry))) {
    return {
      assertions: { ...failedAssertions },
      id: 'failure-drills',
      kind: 'command',
      outcome: 'failed',
      reason: 'failure-drills runner is absent; gate fails closed.',
    };
  }

  if (injectedEvidenceDirectory) {
    const verified = await evaluateFailureDrillEvidenceDirectory(
      injectedEvidenceDirectory,
      injectedReportsDirectory,
    );
    if (!verified) {
      return {
        assertions: { ...failedAssertions },
        id: 'failure-drills',
        kind: 'command',
        outcome: 'failed',
        reason:
          'Injected failure-drill evidence failed strict multi-scenario verify (forged/missing raw evidence rejected).',
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
      reason:
        'Structured multi-scenario failure-drill evidence verified against raw report digests.',
    };
  }

  const readiness = assessFailureDrillReadiness();
  if (!readiness.ok) {
    return {
      assertions: { ...failedAssertions },
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

  const verified = await evaluateFailureDrillEvidenceDirectory(evidenceDirectory, reportsDirectory);
  if (collect.code !== 0 || suiteFailed || !verified) {
    return {
      assertions: { ...failedAssertions },
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
