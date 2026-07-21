#!/usr/bin/env bun
/**
 * M15 Q06 recovery drill entrypoint (backup/restore + app rollback).
 *
 * Usage:
 *   bun run scripts/enterprise/recovery-drill.ts backup-restore --candidate-sha <sha> --schema-tag <tag> --scope <local-harness|production-authorized> --output <json> [--production-ack]
 *   bun run scripts/enterprise/recovery-drill.ts app-rollback --candidate-sha <sha> --scope <local-harness|production-authorized> --output <json> [--repo-root <dir>]
 *   bun run scripts/enterprise/recovery-drill.ts select-backup --scope production-authorized
 *   bun run scripts/enterprise/recovery-drill.ts verify-invariants --scope production-authorized
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  type EvidenceScope,
  runAppRollbackDrill,
  runBackupRestoreDrill,
} from './production-readiness';

const usage = () => {
  console.error(`Usage:
  bun run scripts/enterprise/recovery-drill.ts backup-restore --candidate-sha <sha> --schema-tag <tag> --scope <scope> --output <json> [--production-ack]
  bun run scripts/enterprise/recovery-drill.ts app-rollback --candidate-sha <sha> --scope <scope> --output <json> [--repo-root <dir>]
  bun run scripts/enterprise/recovery-drill.ts select-backup --scope production-authorized
  bun run scripts/enterprise/recovery-drill.ts verify-invariants --scope production-authorized`);
};

const requireString = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
};

const parseScope = (value: string | undefined): EvidenceScope => {
  const scope = requireString(value, 'scope');
  if (scope !== 'local-harness' && scope !== 'ci-harness' && scope !== 'production-authorized') {
    throw new Error('--scope must be local-harness, ci-harness, or production-authorized');
  }
  return scope;
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === 'select-backup') {
    // Operator-facing stub: selection is environment-specific; never invent production paths.
    console.log(
      JSON.stringify(
        {
          result: 'not-executed',
          reason: 'operator-must-provide-source-backup-evidence',
          scope: 'production-authorized',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (command === 'verify-invariants') {
    console.log(
      JSON.stringify(
        {
          result: 'not-executed',
          reason: 'run-backup-restore-drill-for-invariant-evidence',
          scope: 'production-authorized',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (command === 'backup-restore') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'candidate-sha': { type: 'string' },
        'output': { type: 'string' },
        'production-ack': { type: 'boolean' },
        'schema-tag': { type: 'string' },
        'scope': { type: 'string' },
      },
      strict: true,
    });
    const result = await runBackupRestoreDrill({
      candidateSha: requireString(values['candidate-sha'], 'candidate-sha'),
      dbSchemaVersionTag: requireString(values['schema-tag'], 'schema-tag'),
      outputPath: path.resolve(requireString(values.output, 'output')),
      productionAcknowledgement: values['production-ack'] === true,
      scope: parseScope(values.scope),
    });
    console.log(
      [
        `lane=${result.evidence.lane}`,
        `status=${result.evidence.status}`,
        `scope=${result.evidence.scope}`,
        `cleanup=${result.evidence.cleanupResult}`,
        `assertions=${result.evidence.assertions.passed}/${result.evidence.assertions.total}`,
      ].join(' '),
    );
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'app-rollback') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'candidate-sha': { type: 'string' },
        'output': { type: 'string' },
        'repo-root': { type: 'string' },
        'scope': { type: 'string' },
      },
      strict: true,
    });
    const result = await runAppRollbackDrill({
      candidateSha: requireString(values['candidate-sha'], 'candidate-sha'),
      outputPath: path.resolve(requireString(values.output, 'output')),
      repoRoot: values['repo-root'] ? path.resolve(values['repo-root']) : process.cwd(),
      scope: parseScope(values.scope),
    });
    console.log(
      [
        `lane=${result.evidence.lane}`,
        `status=${result.evidence.status}`,
        `scope=${result.evidence.scope}`,
        `baselineExecutable=${result.evidence.baselineExecutable}`,
        `cleanup=${result.evidence.cleanupResult}`,
      ].join(' '),
    );
    process.exitCode = result.exitCode;
    return;
  }

  usage();
  process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Recovery drill failed');
  process.exitCode = 2;
});
