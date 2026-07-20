#!/usr/bin/env bun
/**
 * M15 Q03 Wave2-A: 2.2.10 → current migration compatibility verifier.
 *
 * Usage:
 *   bun run scripts/enterprise/verify-migration.ts
 *   bun run scripts/enterprise/verify-migration.ts --repo-root .
 *   bun run scripts/enterprise/verify-migration.ts --dump-file /path/to/sanitized.dump
 *
 * Dump path is never written into the report. Missing dump stays overall=unverified.
 * Operates only on a random owned disposable Postgres container; never phase0.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { gatePassed, runMigrationCompatVerification } from './verify-migration/index';

const usage = () => {
  console.error(
    'Usage: bun run scripts/enterprise/verify-migration.ts [--repo-root <dir>] [--dump-file <path>] [--json]',
  );
};

const main = async () => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      'dump-file': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
      'json': { type: 'boolean' },
      'repo-root': { type: 'string' },
    },
    strict: true,
  });

  if (values.help) {
    usage();
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultRoot = path.resolve(scriptDir, '../..');
  const repoRoot = path.resolve(values['repo-root'] ?? defaultRoot);
  const dumpFile = values['dump-file'];

  const { report } = await runMigrationCompatVerification({
    externalDump: dumpFile ? { localPath: dumpFile } : undefined,
    repoRoot,
  });

  if (values.json) {
    // Report is already secret-free by contract.
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      [
        `lane=${report.lane}`,
        `overall=${report.overall}`,
        `synthetic=${report.syntheticResult}`,
        `cleanup=${report.cleanupResult}`,
        `baseline=${report.baseline.match}`,
        `migrations=${report.head.totalMigrationCount}`,
        `postBaseline=${report.head.postBaselineMigrationCount}`,
        `externalDump=${report.externalDump.status}`,
        `elapsedMs=${report.elapsed.milliseconds}`,
      ].join(' '),
    );
    for (const check of report.checks) {
      console.log(`check ${check.category}=${check.result} durationMs=${check.durationMs}`);
    }
  }

  // Exit codes:
  // 0 = synthetic foundation passed (overall may still be unverified without dump)
  // 1 = synthetic failed or cleanup failed
  // 2 = overall failed due to privacy rejection
  if (report.overall === 'failed' && report.externalDump.status === 'privacy-rejected') {
    process.exitCode = 2;
    return;
  }
  if (!gatePassed(report) || report.cleanupResult === 'failed') {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
};

main().catch(() => {
  // Never print raw errors (may contain connection details).
  console.error('Migration compatibility verification failed');
  process.exitCode = 1;
});
