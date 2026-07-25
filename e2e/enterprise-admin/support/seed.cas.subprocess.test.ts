/**
 * End-to-end lifecycle: real SIGINT/SIGTERM subprocess CAS restore.
 * Contract-level cases live in seed.casRestore.contract.test.ts and
 * seed.commitLifecycle.contract.test.ts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { digestFingerprint, snapshotGlobalDbDigest } from './seed';
import { startCasPostgres } from './seed.casHarness';

const PROJECT = path.resolve(__dirname, '../../..');
const CHILD = path.join(__dirname, '../scripts/cas-signal-child.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CAS real signal subprocess (end-to-end lifecycle)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  }, 60_000);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`real ${signal} after ready restores exact before digest`, async () => {
      const harness = await startCasPostgres();
      cleanups.push(harness.stop);
      const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));

      const dir = mkdtempSync(path.join(tmpdir(), 'cas-sig-'));
      const readyFile = path.join(dir, 'ready');
      const beforeFpFile = path.join(dir, 'before.fp');

      const child = spawn('bun', [CHILD], {
        cwd: PROJECT,
        detached: true,
        env: {
          ...process.env,
          CAS_BEFORE_FP_FILE: beforeFpFile,
          CAS_DATABASE_URL: harness.databaseUrl,
          CAS_READY_FILE: readyFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const deadline = Date.now() + 60_000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`child exited early code=${child.exitCode}`);
        }
        await sleep(200);
      }
      expect(existsSync(readyFile)).toBe(true);
      expect(readFileSync(beforeFpFile, 'utf8')).toBe(beforeFp);
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
        beforeFp,
      );

      child.kill(signal);
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 30_000);
      });

      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

      rmSync(dir, { force: true, recursive: true });
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 120_000);

    it(`real ${signal} on never-released post-COMMIT barrier restores without parent release`, async () => {
      const harness = await startCasPostgres();
      cleanups.push(harness.stop);
      const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));

      const dir = mkdtempSync(path.join(tmpdir(), 'cas-pre-ready-'));
      const barrierDir = path.join(dir, 'barrier');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(barrierDir, { recursive: true });
      const beforeFpFile = path.join(dir, 'before.fp');
      const postCommit = path.join(barrierDir, 'post-commit');
      // Intentionally NEVER write barrierDir/release — fail-closed restore must not need it.

      const child = spawn('bun', [CHILD], {
        cwd: PROJECT,
        detached: true,
        env: {
          ...process.env,
          CAS_BEFORE_FP_FILE: beforeFpFile,
          CAS_DATABASE_URL: harness.databaseUrl,
          E2E_CAS_POST_COMMIT_BARRIER_DIR: barrierDir,
          // no CAS_READY_FILE — signal while hung post-COMMIT
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const deadline = Date.now() + 60_000;
      while (!existsSync(postCommit) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`child exited early code=${child.exitCode}`);
        }
        await sleep(50);
      }
      expect(existsSync(postCommit)).toBe(true);
      expect(readFileSync(beforeFpFile, 'utf8')).toBe(beforeFp);
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(
        beforeFp,
      );

      const signalAt = Date.now();
      child.kill(signal);
      // Parent does NOT release the barrier — journal is already restorable after COMMIT.

      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 20_000);
      });

      const exitMs = Date.now() - signalAt;
      expect(exitMs).toBeLessThan(15_000);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      // Parent independently proves full before digest restored
      expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

      rmSync(dir, { force: true, recursive: true });
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 90_000);
  }
});
