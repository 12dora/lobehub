/**
 * Orchestrate automated adversarial security regression adapters.
 * Records actual exit/results; never renames unit tests as external penetration tests.
 * Optional fields are omitted entirely when absent (no explicit undefined keys).
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { SECURITY_ACCEPTANCE_SCHEMA_VERSION } from './constants';
import { omitUndefinedDeep } from './omitUndefined';
import { PEN_REGRESSION_MANIFEST, type PenAdapterDefinition } from './penManifest';
import { type ProcessRunner, runProcess } from './process';
import type { PenRegressionArtifact } from './schemas';
import { validateSkipMultiset } from './skipMultiset';

const vitestJsonReportSchema = z
  .object({
    numFailedTests: z.number().int().nonnegative(),
    numPassedTests: z.number().int().nonnegative(),
    numPendingTests: z.number().int().nonnegative(),
    numTodoTests: z.number().int().nonnegative().optional(),
    numTotalTests: z.number().int().nonnegative(),
    success: z.boolean().optional(),
    testResults: z
      .array(
        z
          .object({
            assertionResults: z
              .array(
                z
                  .object({
                    status: z.enum(['failed', 'passed', 'pending', 'skipped', 'todo']),
                    title: z.string(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface PenRegressionOptions {
  cwd: string;
  manifest?: readonly PenAdapterDefinition[];
  runProcess?: ProcessRunner;
  timeoutMs?: number;
}

type PenAdapterResult = PenRegressionArtifact['adapters'][number];

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const extractVitestJson = (stdout: string, stderr: string): unknown => {
  const combined = `${stdout}\n${stderr}`;
  const matches = combined.match(/\{[\s\S]*\}/gu);
  if (!matches || matches.length === 0) {
    throw new Error('no-vitest-json');
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(matches[i]!) as unknown;
    } catch {
      // continue
    }
  }
  throw new Error('malformed-vitest-json');
};

const resolveTargets = async (
  adapter: PenAdapterDefinition,
  repoRoot: string,
): Promise<{ missing: string[]; present: string[] }> => {
  const missing: string[] = [];
  const present: string[] = [];
  for (const relative of adapter.testFiles) {
    const absolute = path.join(repoRoot, relative);
    if (await fileExists(absolute)) present.push(relative);
    else missing.push(relative);
  }
  return { missing, present };
};

const collectSkippedTitles = (report: z.infer<typeof vitestJsonReportSchema>): string[] => {
  const titles: string[] = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (
        assertion.status === 'skipped' ||
        assertion.status === 'pending' ||
        assertion.status === 'todo'
      ) {
        titles.push(assertion.title);
      }
    }
  }
  titles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return titles;
};

const adapterResult = (value: PenAdapterResult): PenAdapterResult => omitUndefinedDeep(value);

const runOneAdapter = async (
  adapter: PenAdapterDefinition,
  options: {
    cwd: string;
    runner: ProcessRunner;
    timeoutMs?: number;
  },
): Promise<PenAdapterResult> => {
  const { missing, present } = await resolveTargets(adapter, options.cwd);
  const targets = [...adapter.testFiles];

  if (missing.length > 0) {
    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      reason: 'missing-test-target',
      status: 'not-executed',
      targets,
    });
  }

  const workDir = adapter.workingDirectory
    ? path.join(options.cwd, adapter.workingDirectory)
    : options.cwd;
  const configRel = adapter.vitestConfig ?? 'vitest.config.mts';
  const testArgs = adapter.workingDirectory
    ? present.map((file) => path.relative(adapter.workingDirectory!, file) || path.basename(file))
    : [...present];

  const argv = [
    'bunx',
    'vitest',
    'run',
    '--config',
    configRel,
    '--silent=passed-only',
    '--reporter=json',
    ...testArgs,
  ];

  let result;
  try {
    result = await options.runner(argv, {
      cwd: workDir,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      reason: 'adapter-spawn-failed',
      status: 'unavailable',
      targets,
    });
  }

  if (result.timedOut) {
    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: result.code,
      reason: result.cleanupFailed ? 'adapter-timeout-cleanup-failed' : 'adapter-timeout',
      status: 'unavailable',
      targets,
    });
  }

  if (result.outputTruncated) {
    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: result.code,
      reason: 'adapter-output-truncated',
      status: 'unavailable',
      targets,
    });
  }

  let assertions:
    | {
        failed: number;
        passed: number;
        skipped: number;
        total: number;
      }
    | undefined;
  let skippedTitles: string[] | undefined;

  try {
    const json = extractVitestJson(result.stdout, result.stderr);
    const summary = vitestJsonReportSchema.parse(json);
    const skipped = summary.numPendingTests + (summary.numTodoTests ?? 0);
    assertions = {
      failed: summary.numFailedTests,
      passed: summary.numPassedTests,
      skipped,
      total: summary.numTotalTests,
    };
    skippedTitles = collectSkippedTitles(summary);
    if (assertions.passed + assertions.failed + assertions.skipped !== assertions.total) {
      return adapterResult({
        adapterId: adapter.id,
        category: adapter.category,
        assertions,
        exitCode: result.code,
        reason: 'malformed-assertion-counts',
        ...(skippedTitles.length > 0 ? { skippedTitles } : {}),
        status: 'failed',
        targets,
      });
    }
  } catch {
    // Fall through using exit code.
  }

  if (
    result.code === 0 &&
    assertions &&
    assertions.total > 0 &&
    assertions.failed === 0 &&
    assertions.passed + assertions.skipped === assertions.total
  ) {
    const titles = skippedTitles ?? [];
    if (titles.length !== assertions.skipped) {
      return adapterResult({
        adapterId: adapter.id,
        category: adapter.category,
        assertions,
        exitCode: 0,
        reason: 'skipped-titles-incomplete',
        ...(titles.length > 0 ? { skippedTitles: titles } : {}),
        status: 'failed',
        targets,
      });
    }

    const skipVerdict = validateSkipMultiset(titles, adapter.expectedSkips ?? []);
    if (!skipVerdict.ok) {
      return adapterResult({
        adapterId: adapter.id,
        category: adapter.category,
        assertions,
        exitCode: 0,
        reason: skipVerdict.reason,
        ...(titles.length > 0 ? { skippedTitles: titles } : {}),
        status: 'failed',
        targets,
      });
    }

    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      assertions,
      exitCode: 0,
      ...(titles.length > 0 ? { skippedTitles: titles } : {}),
      status: 'passed',
      targets,
    });
  }

  if (result.code === 0 && !assertions) {
    return adapterResult({
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: 0,
      reason: 'missing-assertions',
      status: 'failed',
      targets,
    });
  }

  return adapterResult({
    adapterId: adapter.id,
    category: adapter.category,
    ...(assertions ? { assertions } : {}),
    exitCode: result.code,
    reason: result.code === 0 ? 'incomplete-pass-criteria' : 'adapter-failed',
    ...(skippedTitles && skippedTitles.length > 0 ? { skippedTitles } : {}),
    status: 'failed',
    targets,
  });
};

export const runPenRegression = async (
  options: PenRegressionOptions,
): Promise<PenRegressionArtifact> => {
  const manifest = options.manifest ?? PEN_REGRESSION_MANIFEST;
  const runner = options.runProcess ?? runProcess;
  const adapters: PenRegressionArtifact['adapters'] = [];

  for (const definition of manifest) {
    adapters.push(
      await runOneAdapter(definition, {
        cwd: options.cwd,
        runner,
        timeoutMs: options.timeoutMs,
      }),
    );
  }

  if (adapters.length === 0) {
    return omitUndefinedDeep({
      adapters: [
        {
          adapterId: 'manifest-empty',
          category: 'ssrf',
          reason: 'empty-manifest',
          status: 'not-executed' as const,
          targets: ['missing'],
        },
      ],
      checkId: 'pen-regression' as const,
      reason: 'empty-manifest',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'not-executed' as const,
    });
  }

  const required = adapters.filter((adapter) => {
    const definition = manifest.find((item) => item.id === adapter.adapterId);
    return definition?.required !== false;
  });

  const anyUnavailable = required.some((adapter) => adapter.status === 'unavailable');
  const anyNotExecuted = required.some((adapter) => adapter.status === 'not-executed');
  const anyFailed = required.some((adapter) => adapter.status === 'failed');
  const allPassed = required.every((adapter) => adapter.status === 'passed');

  if (allPassed) {
    return omitUndefinedDeep({
      adapters,
      checkId: 'pen-regression' as const,
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'passed' as const,
    });
  }

  let status: PenRegressionArtifact['status'];
  let reason: string;
  if (anyUnavailable) {
    status = 'unavailable';
    reason = 'adapter-unavailable';
  } else if (anyNotExecuted) {
    status = 'failed';
    reason = 'missing-required-adapter';
  } else if (anyFailed) {
    status = 'failed';
    reason = 'adapter-failed';
  } else {
    status = 'failed';
    reason = 'incomplete-coverage';
  }

  return omitUndefinedDeep({
    adapters,
    checkId: 'pen-regression' as const,
    reason,
    schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
    status,
  });
};
