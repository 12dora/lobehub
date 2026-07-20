import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    for (const port of before!.ownedPorts) {
      expect(await isLocalPortListening(port)).toBe(false);
    }
    expect(after!.signalHandlersInstalled).toBe(false);
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

  it('after-build runs default bun run build then cleans processes/ports/handlers (no SKIP, no custom cmd)', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
    delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    const fault = await runFault('after-build');
    // Build must have registered at least one owned process (bun run build parent)
    expect(fault.lifecycleEvidenceBefore!.evidencePids.length).toBeGreaterThan(0);
  }, 1_200_000);

  it('after-app-spawn cleans owned resources', async () => {
    await runFault('after-app-spawn');
  }, 240_000);

  it('production start build never mutates global .next/lock sentinel', async () => {
    const lockDir = path.join(PROJECT_ROOT, '.next');
    const lockPath = path.join(lockDir, 'lock');
    mkdirSync(lockDir, { recursive: true });
    const sentinel = `foreign-global-lock-sentinel-${Date.now()}-exact-bytes\n`;
    const existed = existsSync(lockPath);
    const previous = existed ? readFileSync(lockPath) : null;
    writeFileSync(lockPath, sentinel, 'utf8');
    const beforeBytes = readFileSync(lockPath);

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

    // Global lock must be byte-for-byte unchanged (suite only touches owned distDir).
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath)).toEqual(beforeBytes);
    expect(readFileSync(lockPath, 'utf8')).toBe(sentinel);

    // Restore exact prior state (or remove our sentinel if none existed)
    if (previous === null) {
      const { rm } = await import('node:fs/promises');
      await rm(lockPath, { force: true });
    } else {
      writeFileSync(lockPath, previous);
    }
  }, 1_200_000);
});
