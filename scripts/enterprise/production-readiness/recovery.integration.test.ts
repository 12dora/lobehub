// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { loadGateEvidenceFile, runProductionPreflight } from './index';
import { runAppRollbackDrill, runBackupRestoreDrill } from './recovery';
import {
  buildCandidate,
  buildPlan,
  FIXTURE_CANDIDATE_SHA,
  FIXTURE_MIGRATION_TAG,
} from './testFixtures';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const dockerAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
};

const hasDocker = await dockerAvailable();

describe.runIf(hasDocker)('recovery integration (owned PostgreSQL)', () => {
  it('backup-restore local-harness positive path: status=passed exit=0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const outputPath = path.join(dir, 'backup-restore.json');

    const result = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath,
      scope: 'local-harness',
    });

    expect(result.evidence.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    for (const inv of result.evidence.invariants) {
      expect(inv.result).toBe('passed');
    }
    // Envelope layout
    const envelope = path.join(dir, 'envelopes', 'backup-restore.envelope.json');
    const loaded = await loadGateEvidenceFile(envelope);
    expect(loaded.artifactSha256).toBe(result.gateEvidence.artifactSha256);

    // Preflight on evidence dir with raw neighbor must not parse raw
    await writeFile(path.join(dir, 'raw', 'noise.json'), '{"not":"a-gate"}');
    const preflightOut = path.join(dir, 'preflight.json');
    await runProductionPreflight({
      candidate: buildCandidate(),
      evidence: [loaded],
      mode: 'validate-harness',
      outputPath: preflightOut,
      plan: buildPlan(),
    });
  }, 180_000);

  it('app-rollback is required-but-unavailable: fail-safe unverified (never planted-probe pass)', async () => {
    const { APP_ROLLBACK_IMPLEMENTATION_STATUS } = await import('./constants');
    // Contract: gate stays required but capability is explicitly unavailable.
    expect(APP_ROLLBACK_IMPLEMENTATION_STATUS.status).toBe('unavailable');
    expect(APP_ROLLBACK_IMPLEMENTATION_STATUS.required).toBe(true);
    expect(APP_ROLLBACK_IMPLEMENTATION_STATUS.reasonCode).toBe('baseline-orm-runtime-unavailable');

    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const result = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'app-rollback.json'),
      repoRoot: process.cwd(),
      scope: 'local-harness',
    });
    // Fail-safe path: without full baseline monorepo install, must not pass.
    expect(result.evidence.baselineExecutable).toBe(false);
    expect(result.evidence.status).toBe('unverified');
    expect(result.exitCode).toBe(1);
    expect(result.baselineDetail).toMatch(
      /baseline-orm-runtime-unavailable|import-failed|materialize/i,
    );
    expect(result.evidence.destructiveCommandsRejected).toBe(true);
    expect(result.evidence.newTablesRetained).toBe(true);
    // Envelope still consumable as unverified evidence (never false passed).
    const envPath = path.join(dir, 'envelopes', 'app-rollback.envelope.json');
    const loaded = await loadGateEvidenceFile(envPath);
    expect(loaded.gate).toBe('app-rollback');
    expect(loaded.status).toBe('unverified');
  }, 180_000);

  it('marker file cannot authorize baselineExecutable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'm15q06-empty-'));
    tempDirs.push(emptyRoot);
    await mkdir(path.join(emptyRoot, '.records/enterprise-app-rollback'), { recursive: true });
    await writeFile(
      path.join(emptyRoot, '.records/enterprise-app-rollback/baseline-probe.ready'),
      'forged',
    );
    const forged = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'forged.json'),
      repoRoot: emptyRoot,
      scope: 'local-harness',
    });
    expect(forged.evidence.baselineExecutable).toBe(false);
    expect(forged.evidence.status).not.toBe('passed');
  }, 120_000);

  it('E2E CLI: recovery-drill → evidence dir with raw neighbor → preflight parse', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-e2e-'));
    tempDirs.push(dir);
    const evidenceDir = path.join(dir, 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    const outputPath = path.join(evidenceDir, 'backup-restore.json');
    const candidatePath = path.join(dir, 'candidate.json');
    const planPath = path.join(dir, 'plan.json');
    const preflightOut = path.join(dir, 'preflight.json');

    await writeFile(
      candidatePath,
      JSON.stringify(buildCandidate({ gitSha: FIXTURE_CANDIDATE_SHA })),
      'utf8',
    );
    await writeFile(planPath, JSON.stringify(buildPlan()), 'utf8');

    // Official recovery-drill CLI
    await execFileAsync(
      'bun',
      [
        'run',
        'scripts/enterprise/recovery-drill.ts',
        'backup-restore',
        '--candidate-sha',
        FIXTURE_CANDIDATE_SHA,
        '--schema-tag',
        FIXTURE_MIGRATION_TAG,
        '--scope',
        'local-harness',
        '--output',
        outputPath,
      ],
      { cwd: process.cwd(), timeout: 180_000 },
    );

    // Layout: raw + envelopes + convenience output
    const { readdir } = await import('node:fs/promises');
    const envelopes = await readdir(path.join(evidenceDir, 'envelopes'));
    expect(envelopes).toContain('backup-restore.envelope.json');
    const raw = await readdir(path.join(evidenceDir, 'raw'));
    expect(raw.some((n) => n.endsWith('.raw.json'))).toBe(true);

    // Neighbor raw noise must not break preflight
    await writeFile(path.join(evidenceDir, 'raw', 'noise.json'), '{"forged":true}');
    await writeFile(path.join(evidenceDir, 'extra-junk.json'), '{"gate":"path-boundaries"}');

    const { stdout, stderr } = await execFileAsync(
      'bun',
      [
        'run',
        'scripts/enterprise/preflight.ts',
        'validate-harness',
        '--candidate',
        candidatePath,
        '--plan',
        planPath,
        '--evidence-dir',
        evidenceDir,
        '--output',
        preflightOut,
      ],
      { cwd: process.cwd(), timeout: 60_000 },
    );
    void stdout;
    void stderr;
    const report = JSON.parse(
      await (await import('node:fs/promises')).readFile(preflightOut, 'utf8'),
    );
    expect(report.overall).not.toBe('passed'); // harness never production pass
    const br = report.checks?.find((c: { gate: string }) => c.gate === 'backup-restore');
    expect(br).toBeDefined();
    expect(br.result === 'passed' || br.result === 'unverified' || br.result === 'failed').toBe(
      true,
    );
    // Must have parsed envelope, not raw
    expect(br.result).not.toBe('not-executed');
  }, 240_000);
});

describe.runIf(!hasDocker)('recovery integration skip lane', () => {
  it('documents docker unavailability without claiming production pass', () => {
    expect(hasDocker).toBe(false);
  });
});
