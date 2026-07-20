import type { InjectionClassification, RecoveryClassification } from './contract';

export interface FailureDrillReport {
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
      { expectedAssertions: 18, reportFile: 'postgres-multiconnection-server.json' },
      { expectedAssertions: 1, reportFile: 'postgres-multiconnection-database.json' },
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
    reports: [{ expectedAssertions: 1, reportFile: 'identity-startup-lock-release.json' }],
    scenarioId: 'identity-startup-lock-release',
  },
  {
    injection: 'redis-version-key-loss',
    recovery: 'database-source-reload',
    reports: [{ expectedAssertions: 1, reportFile: 'redis-database-rebuild.json' }],
    scenarioId: 'redis-database-rebuild',
  },
] as const satisfies readonly FailureDrillScenario[];
