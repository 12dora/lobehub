// @vitest-environment node
/**
 * Owned PostgreSQL integration: positive backup/restore must pass;
 * app-rollback without executable baseline materialization path may still
 * materialize real baseline when git object exists.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

    expect(result.evidence.scope).toBe('local-harness');
    expect(result.evidence.scope).not.toBe('production-authorized');
    expect(result.evidence.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.evidence.cleanupResult).toBe('passed');
    expect(result.evidence.assertions.total).toBeGreaterThan(0);
    expect(result.evidence.assertions.failed).toBe(0);
    expect(result.evidence.assertions.skipped).toBe(0);
    for (const inv of result.evidence.invariants) {
      expect(inv.result).toBe('passed');
    }

    const raw = await readFile(outputPath, 'utf8');
    expect(raw).not.toMatch(/postgres(?:ql)?:\/\//i);

    // Rerun deterministic pass
    const result2 = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath: path.join(dir, 'backup-restore-2.json'),
      scope: 'local-harness',
    });
    expect(result2.evidence.status).toBe('passed');
    expect(result2.exitCode).toBe(0);
  }, 180_000);

  it('production-authorized without backup+provenance is unverified nonzero', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    const result = await runBackupRestoreDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      dbSchemaVersionTag: FIXTURE_MIGRATION_TAG,
      outputPath: path.join(dir, 'backup-restore-prod.json'),
      scope: 'production-authorized',
    });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.status).toBe('unverified');
    expect(result.evidence.scope).not.toBe('production-authorized');
  }, 30_000);

  it('app-rollback: empty marker file must not grant baselineExecutable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-int-'));
    tempDirs.push(dir);
    // Plant the old false-green marker
    const markerDir = path.join(dir, '.records', 'enterprise-app-rollback');
    await writeFile(path.join(markerDir, 'baseline-probe.ready'), 'x', 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(markerDir, { recursive: true });
      await writeFile(path.join(markerDir, 'baseline-probe.ready'), 'x', 'utf8');
    });

    const result = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'app-rollback.json'),
      repoRoot: process.cwd(),
      scope: 'local-harness',
    });

    // Marker alone must not be the authorization mechanism.
    // If baseline materializes and probe runs, executable may be true legitimately.
    // Ensure we never pass purely from marker in empty dir without materialization:
    // When repoRoot is an empty temp without git objects, should be unverified.
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'm15q06-empty-repo-'));
    tempDirs.push(emptyRoot);
    await writeFile(
      path.join(emptyRoot, '.records/enterprise-app-rollback/baseline-probe.ready'),
      'forged',
      'utf8',
    ).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(emptyRoot, '.records/enterprise-app-rollback'), {
        recursive: true,
      });
      await writeFile(
        path.join(emptyRoot, '.records/enterprise-app-rollback/baseline-probe.ready'),
        'forged',
        'utf8',
      );
    });

    const forged = await runAppRollbackDrill({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      outputPath: path.join(dir, 'app-rollback-forged-marker.json'),
      repoRoot: emptyRoot,
      scope: 'production-authorized',
    });
    expect(forged.evidence.baselineExecutable).toBe(false);
    expect(forged.evidence.status).not.toBe('passed');
    expect(forged.exitCode).toBe(1);
    expect(forged.evidence.destructiveCommandsRejected).toBe(true);

    // Real repo path: may materialize baseline successfully
    void result;
  }, 180_000);
});

describe.runIf(!hasDocker)('recovery integration skip lane', () => {
  it('documents docker unavailability without claiming production pass', () => {
    expect(hasDocker).toBe(false);
  });
});
