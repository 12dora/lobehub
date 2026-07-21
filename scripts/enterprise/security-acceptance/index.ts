#!/usr/bin/env bun
/**
 * M13 PR-S05 enterprise security acceptance CLI.
 *
 * Repository automation evidence only. Never claims external production penetration testing.
 *
 * Usage:
 *   bun scripts/enterprise/security-acceptance/index.ts run --output-dir <dir> [--git-sha <sha>]
 *   bun scripts/enterprise/security-acceptance/index.ts evaluate --checks-dir <dir> --output-dir <dir>
 *   bun scripts/enterprise/security-acceptance/index.ts verify --report <file>
 *   bun scripts/enterprise/security-acceptance/index.ts generate-leakage-baseline
 */
import { parseArgs } from 'node:util';

import {
  evaluateFromChecksDir,
  generateLeakageBaselineFile,
  runSecurityAcceptance,
  verifyReportFile,
} from './runner';

export * from './canonical';
export * from './constants';
export * from './dependencyScan';
export * from './evaluate';
export * from './leakageAllowlist';
export * from './leakageBaseline';
export * from './leakageScan';
export * from './omitUndefined';
export * from './penManifest';
export * from './penRegression';
export * from './privacy';
export * from './process';
export * from './repoPaths';
export * from './runner';
export * from './schemas';
export * from './semantics';
export * from './workflowShell';

const usage = () => {
  console.error(`Usage:
  bun scripts/enterprise/security-acceptance/index.ts run --output-dir <dir> [--git-sha <sha>] [--no-generate-lockfile]
  bun scripts/enterprise/security-acceptance/index.ts evaluate --checks-dir <dir> --output-dir <dir> [--git-sha <sha>]
  bun scripts/enterprise/security-acceptance/index.ts verify --report <file>
  bun scripts/enterprise/security-acceptance/index.ts generate-leakage-baseline [--output <file>]`);
};

const requireOption = (value: string | undefined, option: string): string => {
  if (!value) throw new Error(`Missing required option: ${option}`);
  return value;
};

const resolveGitSha = async (explicit: string | undefined): Promise<string> => {
  if (explicit) {
    if (!/^[a-f\d]{40}$/u.test(explicit)) {
      throw new Error('--git-sha must be a full lowercase 40-char sha');
    }
    return explicit;
  }
  const { runProcess } = await import('./process');
  const result = await runProcess(['git', 'rev-parse', 'HEAD'], { cwd: process.cwd() });
  const sha = result.stdout.trim();
  if (!/^[a-f\d]{40}$/u.test(sha)) {
    throw new Error('Unable to resolve git sha; pass --git-sha');
  }
  return sha;
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      'checks-dir': { type: 'string' },
      'git-sha': { type: 'string' },
      'no-generate-lockfile': { type: 'boolean', default: false },
      'output': { type: 'string' },
      'output-dir': { type: 'string' },
      'report': { type: 'string' },
    },
    strict: true,
  });

  if (command === 'generate-leakage-baseline') {
    const result = await generateLeakageBaselineFile({
      cwd: process.cwd(),
      outputPath: values.output,
    });
    console.log(
      JSON.stringify(
        {
          baselinePath: result.path,
          entryCount: result.count,
          note: 'Review diff before commit. Entries are path+category+lineDigest only.',
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
    return;
  }

  if (command === 'verify') {
    const reportPath = requireOption(values.report, '--report');
    const result = await verifyReportFile(reportPath);
    if (!result.ok) {
      console.error(`verify failed: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          evidenceClass: result.report.evidenceClass,
          externalPenetrationTest: result.report.externalPenetrationTest.status,
          ok: true,
          overall: result.report.overall,
          reportCoreSha256: result.report.integrity.reportCoreSha256,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.report.overall === 'passed' ? 0 : 1;
    return;
  }

  if (command === 'evaluate') {
    const checksDir = requireOption(values['checks-dir'], '--checks-dir');
    const outputDir = requireOption(values['output-dir'], '--output-dir');
    const gitSha = await resolveGitSha(values['git-sha']);
    const result = await evaluateFromChecksDir({ checksDir, gitSha, outputDir });
    console.log(
      JSON.stringify(
        {
          evidenceClass: result.report.evidenceClass,
          exitCode: result.exitCode,
          overall: result.report.overall,
          reportPath: result.reportPath,
          reportSha256: result.reportSha256,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'run') {
    const outputDir = requireOption(values['output-dir'], '--output-dir');
    const gitSha = await resolveGitSha(values['git-sha']);
    const result = await runSecurityAcceptance({
      allowGenerateLockfile: values['no-generate-lockfile'] !== true,
      cwd: process.cwd(),
      gitSha,
      outputDir,
    });
    console.log(
      JSON.stringify(
        {
          checks: result.report.checks,
          evidenceClass: result.report.evidenceClass,
          exitCode: result.exitCode,
          externalPenetrationTest: result.report.externalPenetrationTest.status,
          overall: result.report.overall,
          reportPath: result.reportPath,
          reportSha256: result.reportSha256,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.exitCode;
    return;
  }

  usage();
  process.exitCode = 2;
};

const isDirect =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('security-acceptance/index.ts') ||
    process.argv[1].endsWith('security-acceptance/index.js'));

if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Security acceptance failed');
    process.exitCode = 2;
  });
}
