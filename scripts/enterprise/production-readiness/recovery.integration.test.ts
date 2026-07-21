// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    expect(result.evidence.cleanupResult).toBe('passed');
    for (const inv of result.evidence.invariants) {
      expect(inv.result).toBe('passed');
    }
    // Preflight-consumable envelope
    expect(result.gateEvidence.artifactSha256).toMatch(/^[a-f\d]{64}$/);
    expect(result.gateEvidence.generatedAt).toBeTruthy();
    const loaded = await loadGateEvidenceFile(outputPath);
    expect(loaded.gate).toBe('backup-restore');
    expect(loaded.artifactSha256).toBe(result.gateEvidence.artifactSha256);
  }, 180_000);

  it('app-rollback with real baseline materialization + DB probe can pass', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const outputPath = path.join(dir, 'app-rollback.json');

    const result = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath,
      repoRoot: process.cwd(),
      scope: 'local-harness',
    });

    // Positive: baseline materializes and DB probe runs
    expect(result.evidence.destructiveCommandsRejected).toBe(true);
    if (result.evidence.status === 'passed') {
      expect(result.evidence.baselineExecutable).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.evidence.newTablesRetained).toBe(true);
      expect(result.evidence.rollForwardOk).toBe(true);
    } else {
      // If baseline object missing or deps fail — honest unverified, never fake pass
      expect(result.evidence.status).toBe('unverified');
      expect(result.evidence.baselineExecutable).toBe(false);
      expect(result.exitCode).toBe(1);
    }

    const loaded = await loadGateEvidenceFile(outputPath);
    expect(loaded.gate).toBe('app-rollback');
    expect(loaded.artifactSha256).toBe(result.gateEvidence.artifactSha256);

    // Preflight can consume recovery output
    const evidenceDir = path.join(dir, 'evidence');
    await mkdir(evidenceDir);
    // Minimal other gates as not-executed missing is fine for validate-harness
    await writeFile(path.join(evidenceDir, 'app-rollback.json'), await readFile(outputPath));
    const reportPath = path.join(dir, 'preflight-report.json');
    // Only one gate present — overall unverified but loader must work
    await runProductionPreflight({
      candidate: buildCandidate(),
      evidence: [loaded],
      mode: 'validate-harness',
      outputPath: reportPath,
      plan: buildPlan(),
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { overall: string };
    expect(report.overall).not.toBe('passed');
  }, 180_000);

  it('marker file on empty root cannot authorize baselineExecutable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'm15q06-empty-repo-'));
    tempDirs.push(emptyRoot);
    await mkdir(path.join(emptyRoot, '.records/enterprise-app-rollback'), { recursive: true });
    await writeFile(
      path.join(emptyRoot, '.records/enterprise-app-rollback/baseline-probe.ready'),
      'forged',
      'utf8',
    );

    const forged = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'app-rollback-forged.json'),
      repoRoot: emptyRoot,
      scope: 'production-authorized',
    });
    expect(forged.evidence.baselineExecutable).toBe(false);
    expect(forged.evidence.status).not.toBe('passed');
    expect(forged.exitCode).toBe(1);
  }, 180_000);

  it('production-authorized without backup+manifest+provenance is unverified', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const result = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath: path.join(dir, 'backup-prod.json'),
      scope: 'production-authorized',
    });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.status).toBe('unverified');
  }, 30_000);
});

describe.runIf(!hasDocker)('recovery integration skip lane', () => {
  it('documents docker unavailability without claiming production pass', () => {
    expect(hasDocker).toBe(false);
  });
});
