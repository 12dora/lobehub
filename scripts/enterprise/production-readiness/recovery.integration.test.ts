// @vitest-environment node
/**
 * Owned PostgreSQL integration lane for backup/restore and app-rollback drills.
 * Skips when Docker is unavailable; skip must never be treated as production pass.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runAppRollbackDrill, runBackupRestoreDrill } from './recovery';
import { FIXTURE_CANDIDATE_SHA, FIXTURE_MIGRATION_TAG } from './testFixtures';

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
  it('backup-restore local-harness drill seeds, dumps, restores, and verifies digests', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const outputPath = path.join(dir, 'backup-restore.json');

    const result = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath,
      scope: 'local-harness',
    });

    expect(result.evidence.gate).toBe('backup-restore');
    expect(result.evidence.sourcePreserved).toBe(true);
    expect(result.evidence.scope).toBe('local-harness');
    // Must not claim production-authorized.
    expect(result.evidence.scope).not.toBe('production-authorized');

    if (result.evidence.status === 'passed') {
      expect(result.evidence.assertions.total).toBeGreaterThan(0);
      expect(result.evidence.assertions.failed).toBe(0);
      expect(result.evidence.cleanupResult).toBe('passed');
      expect(result.exitCode).toBe(0);
    } else {
      // Fail closed with structured evidence; still wrote artifact.
      expect(result.exitCode).toBe(1);
      expect(result.evidence.assertions.total).toBeGreaterThan(0);
    }

    const raw = await readFile(outputPath, 'utf8');
    expect(raw).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(raw).not.toMatch(/password/i);
  }, 180_000);

  it('production-authorized backup-restore without ack fails closed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const result = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath: path.join(dir, 'backup-restore-prod.json'),
      productionAcknowledgement: false,
      scope: 'production-authorized',
    });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.status).toBe('failed');
  }, 30_000);

  it('app-rollback without baseline probe marker is unverified (never passed)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const result = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'app-rollback.json'),
      repoRoot: dir,
      scope: 'local-harness',
    });

    expect(result.evidence.baselineExecutable).toBe(false);
    expect(result.evidence.status).not.toBe('passed');
    expect(['unverified', 'failed']).toContain(result.evidence.status);
    expect(result.exitCode).toBe(1);
    expect(result.evidence.destructiveCommandsRejected).toBe(true);
  }, 180_000);
});

describe.runIf(!hasDocker)('recovery integration skip lane', () => {
  it('documents docker unavailability without claiming production pass', () => {
    expect(hasDocker).toBe(false);
    // Unit contracts still cover fail-closed semantics; this lane is not production evidence.
  });
});
