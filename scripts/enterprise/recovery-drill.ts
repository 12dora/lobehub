#!/usr/bin/env bun
/**
 * M15 Q06 recovery drill entrypoint.
 *
 * Production backup-restore is two-step:
 * 1) --provenance = signed source-backup (dump + manifest) → restore writes unsigned
 *    gate envelope + raw report with inputAttestation ref (local/unverified for production pass).
 * 2) finalize-result --result-provenance = externally signed recovery-result over raw report digest.
 * Runtime never holds a production private key and never reuses input as gate provenance.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  type EvidenceScope,
  finalizeBackupRestoreResultProvenance,
  runAppRollbackDrill,
  runBackupRestoreDrill,
} from './production-readiness';

const usage = () => {
  console.error(`Usage:
  bun run scripts/enterprise/recovery-drill.ts backup-restore --candidate-sha <sha> --schema-tag <tag> --scope <scope> --output <json>
    [--backup-file <path>] [--source-manifest <path>] [--provenance <source-backup.json>]
    [--result-provenance <recovery-result.json>] [--release-id <id>]
  bun run scripts/enterprise/recovery-drill.ts finalize-result --raw-report <path> --envelope <path>
    --result-provenance <path> --candidate-sha <sha> [--release-id <id>]
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

  if (command === 'select-backup' || command === 'verify-invariants') {
    console.log(
      JSON.stringify(
        {
          result: 'not-executed',
          reason:
            command === 'select-backup'
              ? 'operator-must-provide-signed-backup-artifact'
              : 'run-backup-restore-with-signed-provenance',
          scope: 'production-authorized',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (command === 'finalize-result') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'raw-report': { type: 'string' },
        'envelope': { type: 'string' },
        'result-provenance': { type: 'string' },
        'candidate-sha': { type: 'string' },
        'release-id': { type: 'string' },
      },
      strict: true,
    });
    const { readFile } = await import('node:fs/promises');
    const resultProvenance = JSON.parse(
      await readFile(requireString(values['result-provenance'], 'result-provenance'), 'utf8'),
    );
    const out = await finalizeBackupRestoreResultProvenance({
      candidateSha: requireString(values['candidate-sha'], 'candidate-sha'),
      envelopePath: path.resolve(requireString(values.envelope, 'envelope')),
      rawReportPath: path.resolve(requireString(values['raw-report'], 'raw-report')),
      releaseId: values['release-id'],
      resultProvenance,
    });
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.ok ? 0 : 1;
    return;
  }

  if (command === 'backup-restore') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'backup-file': { type: 'string' },
        'source-manifest': { type: 'string' },
        'provenance': { type: 'string' },
        'result-provenance': { type: 'string' },
        'release-id': { type: 'string' },
        'candidate-sha': { type: 'string' },
        'output': { type: 'string' },
        'schema-tag': { type: 'string' },
        'scope': { type: 'string' },
      },
      strict: true,
    });
    const { readFile } = await import('node:fs/promises');
    let backupProvenance: unknown;
    if (values.provenance) {
      backupProvenance = JSON.parse(await readFile(values.provenance, 'utf8'));
    }
    let resultProvenance: unknown;
    if (values['result-provenance']) {
      resultProvenance = JSON.parse(await readFile(values['result-provenance']!, 'utf8'));
    }
    const result = await runBackupRestoreDrill({
      backupProvenance,
      backupFile: values['backup-file'],
      sourceManifestPath: values['source-manifest'],
      resultProvenance,
      releaseId: values['release-id'],
      candidateSha: requireString(values['candidate-sha'], 'candidate-sha'),
      dbSchemaVersionTag: requireString(values['schema-tag'], 'schema-tag'),
      outputPath: path.resolve(requireString(values.output, 'output')),
      scope: parseScope(values.scope) as 'ci-harness' | 'local-harness' | 'production-authorized',
    });
    console.log(
      [
        `lane=${result.evidence.lane}`,
        `status=${result.evidence.status}`,
        `scope=${result.evidence.scope}`,
        `cleanup=${result.evidence.cleanupResult}`,
        `assertions=${result.evidence.assertions.passed}/${result.evidence.assertions.total}`,
        `raw=${result.rawReportSha256 ?? 'n/a'}`,
        `gateProvenance=${result.gateEvidence.provenance ? 'present' : 'absent'}`,
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
