import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FailureDrillEvidence, FailureDrillEvidenceCore } from './contract';
import {
  createFailureDrillEvidence,
  FAILURE_DRILL_LANE,
  FAILURE_DRILL_SCHEMA_VERSION,
  isPassingFailureDrillEvidence,
  scanFailureDrillEvidence,
} from './contract';
import { collectFailureDrillEvidence, verifyFailureDrillEvidence } from './runner';
import type { FailureDrillReport } from './scenarios';
import { FAILURE_DRILL_SCENARIOS } from './scenarios';

const GIT_SHA = 'a'.repeat(40);
const DEPENDENCIES = {
  bun: '1.3.5',
  node: '24.13.0',
  postgres: '17.5',
  redis: '7.4.2',
} as const;

interface ReportCounts {
  failed: number;
  passed: number;
  pending: number;
  success: boolean;
  todo: number;
  total: number;
}

interface ReportOverride extends Partial<ReportCounts> {
  omitSelectedAssertions?: boolean;
}

const directories: string[] = [];

const createDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'failure-drills-'));
  directories.push(directory);
  return directory;
};

const createReport = (
  { failed, passed, pending, success, todo, total }: ReportCounts,
  selectedTitles: readonly string[],
) => {
  const statuses = [
    ...Array.from({ length: passed }, () => 'passed' as const),
    ...Array.from({ length: failed }, () => 'failed' as const),
    ...Array.from({ length: pending }, () => 'skipped' as const),
    ...Array.from({ length: todo }, () => 'todo' as const),
  ];
  const titles = [
    ...selectedTitles,
    ...Array.from(
      { length: Math.max(0, total - selectedTitles.length) },
      (_, index) => `intentionally-filtered-${index}`,
    ),
  ];

  return {
    numFailedTests: failed,
    numPassedTests: passed,
    numPendingTests: pending,
    numTodoTests: todo,
    numTotalTests: total,
    startTime: 100,
    success,
    testResults: [
      {
        assertionResults: titles.map((title, index) => ({ status: statuses[index], title })),
        endTime: 125,
      },
    ],
  };
};

const writeReports = async (
  reportsDirectory: string,
  overrides: Record<string, ReportOverride> = {},
) => {
  for (const scenario of FAILURE_DRILL_SCENARIOS) {
    for (const report of scenario.reports) {
      const reportDefinition: FailureDrillReport = report;
      const filteredAssertions = reportDefinition.assertionTitles
        ? reportDefinition.reportFile === 'identity-startup-lock-release.json'
          ? 15
          : 1
        : 0;
      const override = overrides[reportDefinition.reportFile];
      const counts = {
        failed: 0,
        passed: reportDefinition.expectedAssertions,
        pending: filteredAssertions,
        success: true,
        todo: 0,
        total: reportDefinition.expectedAssertions + filteredAssertions,
        ...override,
      } satisfies ReportCounts;
      await writeFile(
        path.join(reportsDirectory, reportDefinition.reportFile),
        JSON.stringify(
          createReport(
            counts,
            override?.omitSelectedAssertions ? [] : (reportDefinition.assertionTitles ?? []),
          ),
        ),
      );
    }
  }
};

const createCoreEvidence = (overrides: Partial<FailureDrillEvidenceCore> = {}) => ({
  artifact: { sha256: 'b'.repeat(64) },
  assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
  cleanupResult: 'passed' as const,
  dependencies: DEPENDENCIES,
  elapsed: { milliseconds: 25 },
  gitSha: GIT_SHA,
  injection: 'redis-version-key-loss' as const,
  lane: FAILURE_DRILL_LANE,
  recovery: 'database-source-reload' as const,
  scenarioId: 'redis-database-rebuild',
  schemaVersion: FAILURE_DRILL_SCHEMA_VERSION,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('failure-drill evidence contract', () => {
  it('rejects forbidden evidence fields and values without echoing them', () => {
    const scan = scanFailureDrillEvidence({
      ciphertext: 'opaque',
      hostname: 'db.internal',
      instanceId: 'instance-1',
      payload: { value: true },
      secret: 'hidden',
      url: 'https://example.test',
    });

    expect(scan).toEqual({ result: 'failed', violations: 7 });
    expect(() =>
      createFailureDrillEvidence({
        ...createCoreEvidence(),
        payload: 'must-not-persist',
      } as FailureDrillEvidenceCore),
    ).toThrow('redaction rejected 1 forbidden field(s)');
  });

  it('rejects non-version dependency values and extra dependency fields', () => {
    expect(() =>
      createFailureDrillEvidence(
        createCoreEvidence({ dependencies: { ...DEPENDENCIES, bun: 'latest' } }),
      ),
    ).toThrow('short numeric dependency version');
    expect(() =>
      createFailureDrillEvidence(
        createCoreEvidence({
          dependencies: { ...DEPENDENCIES, hostname: 'runner-1' } as typeof DEPENDENCIES,
        }),
      ),
    ).toThrow('redaction rejected 1 forbidden field(s)');
  });

  it('treats invalid, skipped, and cleanup-failed evidence as non-passing', () => {
    expect(isPassingFailureDrillEvidence({} as FailureDrillEvidence)).toBe(false);
    expect(
      isPassingFailureDrillEvidence(
        createFailureDrillEvidence(
          createCoreEvidence({ assertions: { failed: 0, passed: 0, skipped: 1, total: 1 } }),
        ),
      ),
    ).toBe(false);
    expect(
      isPassingFailureDrillEvidence(
        createFailureDrillEvidence(createCoreEvidence({ cleanupResult: 'failed' })),
      ),
    ).toBe(false);
  });
});

describe('failure-drill evidence runner', () => {
  it('writes only aggregate records for all fixed scenarios', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory);

    const result = await collectFailureDrillEvidence({
      cleanupResult: 'passed',
      dependencies: DEPENDENCIES,
      gitSha: GIT_SHA,
      outputDirectory,
      reportsDirectory,
    });

    expect(result.passed).toBe(true);
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toMatchObject({
      assertions: { failed: 0, passed: 19, skipped: 0, total: 19 },
      dependencies: DEPENDENCIES,
      redactionScan: { result: 'passed', violations: 0 },
    });
    expect(await verifyFailureDrillEvidence(outputDirectory)).toBe(true);

    const persisted = await readFile(
      path.join(outputDirectory, 'postgres-multiconnection.json'),
      'utf8',
    );
    expect(persisted).not.toMatch(
      /https?:\/\/|postgres(?:ql)?:\/\/|rediss?:\/\/|hostname|instanceId|payload|ciphertext|secret/iu,
    );
  });

  it('returns non-pass when an entire selected suite is skipped', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory, {
      'redis-database-rebuild.json': {
        passed: 0,
        pending: 2,
      },
    });

    const result = await collectFailureDrillEvidence({
      cleanupResult: 'passed',
      dependencies: DEPENDENCIES,
      gitSha: GIT_SHA,
      outputDirectory,
      reportsDirectory,
    });

    expect(result.passed).toBe(false);
    expect(result.records.at(-1)?.assertions).toEqual({
      failed: 0,
      passed: 0,
      skipped: 1,
      total: 1,
    });
  });

  it('returns non-pass when a required assertion fails', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory, {
      'postgres-agent-rollout.json': {
        failed: 1,
        passed: 2,
        success: false,
      },
    });

    const result = await collectFailureDrillEvidence({
      cleanupResult: 'passed',
      dependencies: DEPENDENCIES,
      gitSha: GIT_SHA,
      outputDirectory,
      reportsDirectory,
    });

    expect(result.passed).toBe(false);
    expect(result.records[0].assertions).toEqual({
      failed: 1,
      passed: 18,
      skipped: 0,
      total: 19,
    });
  });

  it('returns non-pass when cleanup fails', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory);

    const result = await collectFailureDrillEvidence({
      cleanupResult: 'failed',
      dependencies: DEPENDENCIES,
      gitSha: GIT_SHA,
      outputDirectory,
      reportsDirectory,
    });

    expect(result.passed).toBe(false);
    expect(result.records.every(({ cleanupResult }) => cleanupResult === 'failed')).toBe(true);
  });

  it('rejects a report with no selected assertions', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory, {
      'identity-startup-lock-release.json': {
        omitSelectedAssertions: true,
      },
    });

    await expect(
      collectFailureDrillEvidence({
        cleanupResult: 'passed',
        dependencies: DEPENDENCIES,
        gitSha: GIT_SHA,
        outputDirectory,
        reportsDirectory,
      }),
    ).rejects.toThrow('expected 1 assertions, received 0');
  });

  it('rejects a missing required report', async () => {
    const reportsDirectory = await createDirectory();
    const outputDirectory = await createDirectory();
    await writeReports(reportsDirectory);
    await rm(path.join(reportsDirectory, 'postgres-agent-rollout.json'));

    await expect(
      collectFailureDrillEvidence({
        cleanupResult: 'passed',
        dependencies: DEPENDENCIES,
        gitSha: GIT_SHA,
        outputDirectory,
        reportsDirectory,
      }),
    ).rejects.toThrow();
  });
});
