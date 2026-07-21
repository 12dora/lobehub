/**
 * Orchestrate automated adversarial security regression adapters.
 * Records actual exit/results; never renames unit tests as external penetration tests.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { SECURITY_ACCEPTANCE_SCHEMA_VERSION } from './constants';
import { PEN_REGRESSION_MANIFEST, type PenAdapterDefinition } from './penManifest';
import { type ProcessRunner, runProcess } from './process';
import type { PenRegressionArtifact } from './schemas';

const vitestJsonSummarySchema = z
  .object({
    numFailedTests: z.number().int().nonnegative(),
    numPassedTests: z.number().int().nonnegative(),
    numPendingTests: z.number().int().nonnegative(),
    numTodoTests: z.number().int().nonnegative().optional(),
    numTotalTests: z.number().int().nonnegative(),
    success: z.boolean().optional(),
  })
  .passthrough();

export interface PenRegressionOptions {
  cwd: string;
  /** Inject manifest for tests. */
  manifest?: readonly PenAdapterDefinition[];
  runProcess?: ProcessRunner;
  timeoutMs?: number;
}

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
  // Prefer last JSON object (vitest json reporter may mix with logs).
  const matches = combined.match(/\{[\s\S]*\}/gu);
  if (!matches || matches.length === 0) {
    throw new Error('no-vitest-json');
  }
  // Try from the end for the report object.
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

const runOneAdapter = async (
  adapter: PenAdapterDefinition,
  options: {
    cwd: string;
    runner: ProcessRunner;
    timeoutMs?: number;
  },
): Promise<PenRegressionArtifact['adapters'][number]> => {
  const { missing, present } = await resolveTargets(adapter, options.cwd);

  if (missing.length > 0) {
    return {
      adapterId: adapter.id,
      category: adapter.category,
      reason: 'missing-test-target',
      status: 'not-executed',
      targets: [...adapter.testFiles],
    };
  }

  const workDir = adapter.workingDirectory
    ? path.join(options.cwd, adapter.workingDirectory)
    : options.cwd;
  const configRel = adapter.vitestConfig ?? 'vitest.config.mts';
  // When workingDirectory is a package, test paths are relative to that package.
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
    return {
      adapterId: adapter.id,
      category: adapter.category,
      reason: 'adapter-spawn-failed',
      status: 'unavailable',
      targets: [...present],
    };
  }

  if (result.timedOut) {
    return {
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: result.code,
      reason: 'adapter-timeout',
      status: 'unavailable',
      targets: [...present],
    };
  }

  if (result.outputTruncated) {
    return {
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: result.code,
      reason: 'adapter-output-truncated',
      status: 'unavailable',
      targets: [...present],
    };
  }

  let assertions:
    | {
        failed: number;
        passed: number;
        skipped: number;
        total: number;
      }
    | undefined;

  try {
    const json = extractVitestJson(result.stdout, result.stderr);
    const summary = vitestJsonSummarySchema.parse(json);
    const skipped = summary.numPendingTests + (summary.numTodoTests ?? 0);
    assertions = {
      failed: summary.numFailedTests,
      passed: summary.numPassedTests,
      skipped,
      total: summary.numTotalTests,
    };
    if (assertions.passed + assertions.failed + assertions.skipped !== assertions.total) {
      return {
        adapterId: adapter.id,
        category: adapter.category,
        assertions,
        exitCode: result.code,
        reason: 'malformed-assertion-counts',
        status: 'failed',
        targets: [...present],
      };
    }
  } catch {
    // Fall through: still use exit code as fail-closed signal.
  }

  if (
    result.code === 0 &&
    assertions &&
    assertions.total > 0 &&
    assertions.failed === 0 &&
    assertions.skipped === 0 &&
    assertions.passed === assertions.total
  ) {
    return {
      adapterId: adapter.id,
      category: adapter.category,
      assertions,
      exitCode: 0,
      status: 'passed',
      targets: [...present],
    };
  }

  if (result.code === 0 && !assertions) {
    // Zero exit without parseable assertions is not a trustworthy pass.
    return {
      adapterId: adapter.id,
      category: adapter.category,
      exitCode: 0,
      reason: 'missing-assertions',
      status: 'failed',
      targets: [...present],
    };
  }

  return {
    adapterId: adapter.id,
    category: adapter.category,
    assertions,
    exitCode: result.code,
    reason: result.code === 0 ? 'incomplete-pass-criteria' : 'adapter-failed',
    status: 'failed',
    targets: [...present],
  };
};

/**
 * Run all pen-regression adapters from the manifest.
 */
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
    return {
      adapters: [
        {
          adapterId: 'manifest-empty',
          category: 'ssrf',
          reason: 'empty-manifest',
          status: 'not-executed',
          targets: ['missing'],
        },
      ],
      checkId: 'pen-regression',
      reason: 'empty-manifest',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'not-executed',
    };
  }

  const required = adapters.filter((adapter) => {
    const definition = manifest.find((item) => item.id === adapter.adapterId);
    return definition?.required !== false;
  });

  const anyUnavailable = required.some((adapter) => adapter.status === 'unavailable');
  const anyNotExecuted = required.some((adapter) => adapter.status === 'not-executed');
  const anyFailed = required.some((adapter) => adapter.status === 'failed');
  const allPassed = required.every((adapter) => adapter.status === 'passed');

  let status: PenRegressionArtifact['status'];
  let reason: string | undefined;
  if (allPassed) {
    status = 'passed';
  } else if (anyUnavailable) {
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

  return {
    adapters,
    checkId: 'pen-regression',
    reason,
    schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
    status,
  };
};
