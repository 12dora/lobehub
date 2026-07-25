import type { InjectionClassification, RecoveryClassification } from './contract';

export interface FailureDrillReport {
  assertionTitles?: readonly string[];
  expectedAssertions: number;
  reportFile: string;
}

export interface FailureDrillScenario {
  injection: InjectionClassification;
  recovery: RecoveryClassification;
  reports: readonly FailureDrillReport[];
  scenarioId: string;
}

export const FAILURE_DRILL_SCENARIOS = [
  {
    injection: 'postgres-concurrent-writers',
    recovery: 'postgres-serialized-outcome',
    reports: [
      { expectedAssertions: 7, reportFile: 'postgres-agent-materialization.json' },
      { expectedAssertions: 3, reportFile: 'postgres-agent-rollout.json' },
      // Includes secret CAS concurrency (merged from secretStore.pgConcurrency.test.ts / F11).
      { expectedAssertions: 4, reportFile: 'postgres-identity-attempt.json' },
      { expectedAssertions: 5, reportFile: 'postgres-secret-rewrap.json' },
      { expectedAssertions: 1, reportFile: 'postgres-platform-instance.json' },
      // SAO-008: audit export publication + retention lease multi-connection suites.
      // Counts must match top-level `it(` / `it.skipIf(` in the wired multiconn files
      // (enforced by runner.test.ts "expectedAssertions match wired test files").
      { expectedAssertions: 5, reportFile: 'postgres-audit-export-publication.json' },
      { expectedAssertions: 1, reportFile: 'postgres-audit-retention-lease.json' },
      // SAI-005: AI catalog publication advisory-lock concurrency.
      { expectedAssertions: 2, reportFile: 'postgres-ai-catalog-publication.json' },
    ],
    scenarioId: 'postgres-multiconnection',
  },
  {
    injection: 'postgres-revision-lag',
    recovery: 'postgres-reconciled-revision',
    reports: [{ expectedAssertions: 4, reportFile: 'identity-convergence.json' }],
    scenarioId: 'identity-convergence',
  },
  {
    injection: 'postgres-lock-owner-termination',
    recovery: 'postgres-advisory-lock-release',
    reports: [
      {
        assertionTitles: [
          'releases the cross-instance advisory lock when the owning PG connection crashes',
        ],
        expectedAssertions: 1,
        reportFile: 'identity-startup-lock-release.json',
      },
    ],
    scenarioId: 'identity-startup-lock-release',
  },
  {
    injection: 'postgres-lock-owner-termination',
    recovery: 'postgres-advisory-lock-release',
    reports: [
      {
        assertionTitles: ['blocks a real concurrent publish between startup recheck and LKG write'],
        expectedAssertions: 1,
        reportFile: 'identity-publish-startup-lock.json',
      },
    ],
    scenarioId: 'identity-publish-startup-lock',
  },
  {
    injection: 'redis-version-key-loss',
    recovery: 'database-source-reload',
    reports: [
      {
        assertionTitles: [
          'converges through request-time version reads across two independent clients',
        ],
        expectedAssertions: 1,
        reportFile: 'redis-database-rebuild.json',
      },
    ],
    scenarioId: 'redis-database-rebuild',
  },
  // SCE-09: three-process branding cache with owned Redis restart (fault proxy + child runtimes).
  {
    injection: 'redis-version-key-loss',
    recovery: 'database-source-reload',
    reports: [
      {
        assertionTitles: [
          'keeps Postgres authoritative through one-process partition and Redis key loss',
        ],
        expectedAssertions: 1,
        reportFile: 'redis-cluster-restart.json',
      },
    ],
    scenarioId: 'redis-cluster-restart',
  },
] as const satisfies readonly FailureDrillScenario[];
