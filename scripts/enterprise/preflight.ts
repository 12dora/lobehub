#!/usr/bin/env bun
/**
 * M15 Q06 production preflight entrypoint.
 * Production overall pass requires repository-pinned cryptographic provenance.
 * CLI never accepts alternate trust-policy paths or env overrides.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildDefaultReleasePlan,
  loadGateEvidenceFile,
  loadReleaseCandidateFile,
  loadReleasePlanFile,
  type PreflightMode,
  runDispatchCommand,
  runProductionPreflight,
  writeJsonAtomic,
} from './production-readiness';

const usage = () => {
  console.error(`Usage:
  bun run scripts/enterprise/preflight.ts <validate-harness|preflight|production-authorized>
    --candidate <json> --plan <json> --evidence-dir <dir> --output <json>
  bun run scripts/enterprise/preflight.ts dispatch --command-id <id> [--execute] [--confirm-execute] [--state-dir <dir>] [--window-id <id>]
  bun run scripts/enterprise/preflight.ts emit-default-plan --candidate-sha <sha> --release-id <id> --output <json>`);
};

const requireString = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
};

const EVIDENCE_FILE_ORDER = [
  'path-boundaries.json',
  'migration-compat.json',
  'enterprise-admin-e2e.json',
  'upstream-rebase.json',
  'failure-drills.json',
  'backup-restore.json',
  'app-rollback.json',
] as const;

const loadEvidenceFromDir = async (directory: string) => {
  const absolute = path.resolve(directory);
  const entries = await readdir(absolute);
  const present = new Set(entries);
  const evidence = [];
  for (const name of EVIDENCE_FILE_ORDER) {
    if (!present.has(name)) continue;
    evidence.push(await loadGateEvidenceFile(path.join(absolute, name)));
  }
  const extras = entries
    .filter(
      (name) =>
        name.endsWith('.json') &&
        !(EVIDENCE_FILE_ORDER as readonly string[]).includes(name) &&
        !name.endsWith('.sig.json'),
    )
    .sort((a, b) => a.localeCompare(b, 'en'));
  for (const name of extras) {
    evidence.push(await loadGateEvidenceFile(path.join(absolute, name)));
  }
  return evidence;
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === 'dispatch') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'command-id': { type: 'string' },
        'confirm-execute': { type: 'boolean' },
        'execute': { type: 'boolean' },
        'state-dir': { type: 'string' },
        'window-id': { type: 'string' },
      },
      strict: true,
    });
    const result = await runDispatchCommand({
      commandId: requireString(values['command-id'], 'command-id'),
      confirmExecute: values['confirm-execute'] === true,
      execute: values.execute === true,
      stateDir: values['state-dir'],
      windowId: values['window-id'],
    });
    console.log(
      JSON.stringify(
        {
          commandId: result.commandId,
          exitCode: result.exitCode,
          mode: result.mode,
          mutates: result.mutates,
          postcondition: result.postcondition,
        },
        null,
        2,
      ),
    );
    if (result.mode === 'unavailable') {
      process.exitCode = result.exitCode ?? 1;
      return;
    }
    if (result.mode === 'executed' && result.exitCode !== 0) {
      process.exitCode = result.exitCode ?? 1;
    }
    return;
  }

  if (command === 'emit-default-plan') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'candidate-sha': { type: 'string' },
        'output': { type: 'string' },
        'release-id': { type: 'string' },
      },
      strict: true,
    });
    const plan = buildDefaultReleasePlan({
      candidateGitSha: requireString(values['candidate-sha'], 'candidate-sha'),
      releaseId: requireString(values['release-id'], 'release-id'),
    });
    await writeJsonAtomic(requireString(values.output, 'output'), plan);
    console.log(`wrote default release plan schemaVersion=${plan.schemaVersion}`);
    return;
  }

  if (
    command !== 'validate-harness' &&
    command !== 'preflight' &&
    command !== 'production-authorized'
  ) {
    usage();
    process.exitCode = 2;
    return;
  }

  // Reject trust-policy CLI overrides if present in argv (strict parseArgs will throw on unknown).
  const mode = command as PreflightMode;
  const { values } = parseArgs({
    args: rest,
    options: {
      'candidate': { type: 'string' },
      'evidence-dir': { type: 'string' },
      'output': { type: 'string' },
      'plan': { type: 'string' },
    },
    strict: true,
  });

  const candidate = await loadReleaseCandidateFile(requireString(values.candidate, 'candidate'));
  const plan = await loadReleasePlanFile(requireString(values.plan, 'plan'));
  const evidence = await loadEvidenceFromDir(requireString(values['evidence-dir'], 'evidence-dir'));
  const outputPath = requireString(values.output, 'output');

  // Never pass a custom trust policy from CLI — production uses PRODUCTION_TRUST_POLICY only.
  const result = await runProductionPreflight({
    candidate,
    evidence,
    mode,
    outputPath,
    plan,
  });

  console.log(
    [
      `lane=${result.report.lane}`,
      `mode=${result.report.mode}`,
      `overall=${result.report.overall}`,
      `classification=${result.report.classification}`,
      `cleanup=${result.report.cleanupResult}`,
      `sha256=${result.reportSha256.slice(0, 12)}`,
    ].join(' '),
  );
  for (const check of result.report.checks) {
    console.log(`check gate=${check.gate} result=${check.result} scope=${check.scope ?? 'none'}`);
  }

  process.exitCode = result.exitCode;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Production preflight failed');
  process.exitCode = 2;
});
