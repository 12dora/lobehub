import { existsSync } from 'node:fs';
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
import { snapshotLockPath, snapshotsEqual } from './lockSentinel';

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
    // Read-only observe of real project lock — never create/overwrite on PROJECT_ROOT.
    const globalLock = path.join(PROJECT_ROOT, '.next', 'lock');
    const lockExisted = existsSync(globalLock);
    const lockBaseline = lockExisted ? snapshotLockPath(globalLock) : null;

    process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
    delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    const fault = await runFault('after-build');
    const before = fault.lifecycleEvidenceBefore!;
    expect(before.evidenceLeaders.length).toBeGreaterThan(0);
    expect(before.evidencePgids.length).toBeGreaterThan(0);
    expect(before.evidencePids.length).toBeGreaterThan(0);
    // Zero-descendant pass is forbidden for real default build.
    expect(before.evidenceDescendants.length).toBeGreaterThan(0);
    expect(before.evidenceDescendants.some((p) => !before.evidenceLeaders.includes(p))).toBe(true);
    expect(before.signalListenerInstalled.SIGINT).toBe(before.signalListenerBaseline.SIGINT + 1);
    expect(before.signalListenerInstalled.SIGTERM).toBe(before.signalListenerBaseline.SIGTERM + 1);

    if (lockBaseline) {
      expect(existsSync(globalLock)).toBe(true);
      expect(snapshotsEqual(lockBaseline, snapshotLockPath(globalLock))).toBe(true);
    } else {
      expect(existsSync(globalLock)).toBe(false);
    }
  }, 1_200_000);

  it('after-app-spawn cleans owned resources', async () => {
    await runFault('after-app-spawn');
  }, 240_000);
});
