#!/usr/bin/env bun
import { parseArgs } from 'node:util';

import { collectFailureDrillEvidence, verifyFailureDrillEvidence } from './runner';

const usage = () => {
  console.error(
    'Usage: bun scripts/enterprise/failure-drills/index.ts collect --git-sha <sha> --reports-dir <dir> --output-dir <dir> --cleanup-result <passed|failed> --bun-version <version> --node-version <version> --postgres-version <version> --redis-version <version>',
  );
  console.error(
    '   or: bun scripts/enterprise/failure-drills/index.ts verify --output-dir <dir> --reports-dir <dir>',
  );
};

const requireOption = (value: string | undefined, option: string): string => {
  if (!value) throw new Error(`Missing required option: ${option}`);
  return value;
};

const main = async () => {
  const [command, ...arguments_] = process.argv.slice(2);
  const { values } = parseArgs({
    args: arguments_,
    options: {
      'bun-version': { type: 'string' },
      'cleanup-result': { type: 'string' },
      'git-sha': { type: 'string' },
      'node-version': { type: 'string' },
      'output-dir': { type: 'string' },
      'postgres-version': { type: 'string' },
      'redis-version': { type: 'string' },
      'reports-dir': { type: 'string' },
    },
    strict: true,
  });
  const outputDirectory = requireOption(values['output-dir'], '--output-dir');

  if (command === 'verify') {
    const reportsDirectory = requireOption(values['reports-dir'], '--reports-dir');
    if (!(await verifyFailureDrillEvidence(outputDirectory, { reportsDirectory }))) {
      process.exitCode = 1;
    }
    return;
  }

  if (command !== 'collect') {
    usage();
    process.exitCode = 2;
    return;
  }

  const cleanupResult = requireOption(values['cleanup-result'], '--cleanup-result');
  if (cleanupResult !== 'failed' && cleanupResult !== 'passed') {
    throw new Error('--cleanup-result must be passed or failed');
  }

  const result = await collectFailureDrillEvidence({
    cleanupResult,
    dependencies: {
      bun: requireOption(values['bun-version'], '--bun-version'),
      node: requireOption(values['node-version'], '--node-version'),
      postgres: requireOption(values['postgres-version'], '--postgres-version'),
      redis: requireOption(values['redis-version'], '--redis-version'),
    },
    gitSha: requireOption(values['git-sha'], '--git-sha'),
    outputDirectory,
    reportsDirectory: requireOption(values['reports-dir'], '--reports-dir'),
  });

  if (!result.passed) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failure-drill evidence runner failed');
  process.exitCode = 2;
});
