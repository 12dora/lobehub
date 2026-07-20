import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_ROOT,
  startEnterpriseAdminRuntime,
  type StartupFaultError,
} from './infrastructure';
import {
  isLocalPortListening,
  isPidAlive,
  isProcessGroupAlive,
  type LifecycleEvidence,
  listContainersByRunToken,
} from './lifecycle';

/**
 * Real startEnterpriseAdminRuntime fault injection for every awaited stage.
 * after-build runs the DEFAULT production `bun run build` (no SKIP_BUILD, no custom cmd).
 */
describe('startEnterpriseAdminRuntime fault injection — all stages', () => {
  const previousFault = process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
  const previousMode = process.env.E2E_ENTERPRISE_ADMIN_MODE;
  const previousSkipBuild = process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;

  afterEach(() => {
    if (previousFault === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
    else process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = previousFault;
    if (previousMode === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_MODE;
    else process.env.E2E_ENTERPRISE_ADMIN_MODE = previousMode;
    if (previousSkipBuild === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    else process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD = previousSkipBuild;
    delete process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL;
  });

  const extractFault = (error: unknown): StartupFaultError | undefined => {
    if (error && typeof error === 'object' && 'runToken' in error) {
      return error as StartupFaultError;
    }
    if (error instanceof AggregateError) {
      for (const inner of error.errors) {
        const t = extractFault(inner);
        if (t) return t;
      }
      return error as AggregateError & StartupFaultError;
    }
    return undefined;
  };

  const assertPostCleanupEvidence = async (
    before: LifecycleEvidence | undefined,
    after: LifecycleEvidence | undefined,
    runToken: string,
  ) => {
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after!.processRegistryPids.every((p) => p === undefined || !isPidAlive(p))).toBe(true);
    expect(after!.processRegistryPids.filter(Boolean)).toHaveLength(0);
    for (const pid of before!.evidencePids) {
      expect(isPidAlive(pid)).toBe(false);
    }
    for (const leader of before!.evidenceLeaders) {
      expect(isPidAlive(leader)).toBe(false);
    }
    for (const desc of before!.evidenceDescendants) {
      expect(isPidAlive(desc)).toBe(false);
    }
    for (const pgid of before!.evidencePgids) {
      expect(isProcessGroupAlive(pgid)).toBe(false);
    }
    for (const port of before!.ownedPorts) {
      expect(await isLocalPortListening(port)).toBe(false);
    }
    expect(after!.signalHandlersInstalled).toBe(false);
    // Exact baseline restoration for SIGINT/SIGTERM listener counts
    expect(after!.signalListenerCurrent.SIGINT).toBe(before!.signalListenerBaseline.SIGINT);
    expect(after!.signalListenerCurrent.SIGTERM).toBe(before!.signalListenerBaseline.SIGTERM);
    expect(after!.containers).toHaveLength(0);
    expect(await listContainersByRunToken(runToken)).toEqual([]);
    const suffix = runToken.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
    expect(existsSync(path.join(PROJECT_ROOT, `.next-e2e-admin-${suffix}`))).toBe(false);
  };

  const runFault = async (stage: string) => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = stage;
    let fault: StartupFaultError | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      fault = extractFault(error);
    }
    expect(fault?.runToken).toBeTruthy();
    await assertPostCleanupEvidence(
      fault!.lifecycleEvidenceBefore,
      fault!.lifecycleEvidenceAfter,
      fault!.runToken!,
    );
    return fault!;
  };

  it('after-postgres cleans owned resources', async () => {
    await runFault('after-postgres');
  }, 90_000);

  it('after-redis cleans owned resources', async () => {
    await runFault('after-redis');
  }, 90_000);

  it('after-migrate cleans owned resources', async () => {
    await runFault('after-migrate');
  }, 180_000);

  it('after-build runs default bun run build then cleans process groups/handlers (no SKIP, no custom cmd)', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
    delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    const fault = await runFault('after-build');
    const before = fault.lifecycleEvidenceBefore!;
    // Build parent/leader + PGID evidence captured while running
    expect(before.evidenceLeaders.length).toBeGreaterThan(0);
    expect(before.evidencePgids.length).toBeGreaterThan(0);
    expect(before.evidencePids.length).toBeGreaterThan(0);
    // Handler install recorded as +1 over baseline (not boolean alone)
    expect(before.signalListenerInstalled.SIGINT).toBe(before.signalListenerBaseline.SIGINT + 1);
    expect(before.signalListenerInstalled.SIGTERM).toBe(before.signalListenerBaseline.SIGTERM + 1);
  }, 1_200_000);

  it('after-app-spawn cleans owned resources', async () => {
    await runFault('after-app-spawn');
  }, 240_000);

  it('production start build never mutates global .next/lock (safe sentinel protocol)', async () => {
    const lockDir = path.join(PROJECT_ROOT, '.next');
    const lockPath = path.join(lockDir, 'lock');
    mkdirSync(lockDir, { recursive: true });

    type Snapshot = {
      bytes: Buffer;
      ino: number;
      mode: number;
      size: number;
      uid: number;
      gid: number;
    };
    const capture = (p: string): Snapshot => {
      const st: Stats = statSync(p);
      return {
        bytes: readFileSync(p),
        gid: st.gid,
        ino: st.ino,
        mode: st.mode,
        size: st.size,
        uid: st.uid,
      };
    };

    let weCreated = false;
    let ownedIno: number | undefined;
    let baseline: Snapshot | undefined;

    try {
      if (existsSync(lockPath)) {
        // Foreign / pre-existing lock — never write, truncate, chmod, or rename.
        baseline = capture(lockPath);
        weCreated = false;
      } else {
        // Exclusive create only when absent (O_EXCL).
        const fd = openSync(lockPath, 'wx');
        try {
          writeFileSync(fd, `e2e-owned-lock-sentinel-${Date.now()}\n`, 'utf8');
        } finally {
          closeSync(fd);
        }
        weCreated = true;
        baseline = capture(lockPath);
        ownedIno = baseline.ino;
      }

      process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
      delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
      process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-build';
      try {
        await startEnterpriseAdminRuntime();
        throw new Error('expected start to fail');
      } catch (error) {
        expect(String(error)).toMatch(/injected startup fault/);
      } finally {
        delete process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
        delete process.env.E2E_ENTERPRISE_ADMIN_MODE;
      }

      // Global lock unchanged: exact bytes + stable identity metadata.
      expect(existsSync(lockPath)).toBe(true);
      const after = capture(lockPath);
      expect(after.bytes.equals(baseline.bytes)).toBe(true);
      expect(after.ino).toBe(baseline.ino);
      expect(after.mode).toBe(baseline.mode);
      expect(after.uid).toBe(baseline.uid);
      expect(after.gid).toBe(baseline.gid);
      expect(after.size).toBe(baseline.size);
    } finally {
      // Outermost finally: only remove the exact sentinel inode we created.
      if (weCreated && ownedIno !== undefined && existsSync(lockPath)) {
        try {
          const st = statSync(lockPath);
          if (st.ino === ownedIno) {
            unlinkSync(lockPath);
          }
        } catch {
          // best-effort
        }
      }
    }
  }, 1_200_000);
});
