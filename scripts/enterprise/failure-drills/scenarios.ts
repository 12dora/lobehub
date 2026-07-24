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
] as const satisfies readonly FailureDrillScenario[];
