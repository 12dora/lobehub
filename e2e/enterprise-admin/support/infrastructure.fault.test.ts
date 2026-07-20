import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT, startEnterpriseAdminRuntime } from './infrastructure';
import { listContainersByRunToken } from './lifecycle';

/**
 * Real startEnterpriseAdminRuntime fault injection for every awaited stage.
 * From outside each failed start: zero containers for that run-token.
 * after-build must execute a verifiable build command (not SKIP_BUILD).
 */
describe('startEnterpriseAdminRuntime fault injection — all stages', () => {
  const previousFault = process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
  const previousMode = process.env.E2E_ENTERPRISE_ADMIN_MODE;
  const previousSkipBuild = process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
  const previousBuildCmd = process.env.E2E_ENTERPRISE_ADMIN_BUILD_COMMAND;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousFault === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
    else process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = previousFault;
    if (previousMode === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_MODE;
    else process.env.E2E_ENTERPRISE_ADMIN_MODE = previousMode;
    if (previousSkipBuild === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    else process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD = previousSkipBuild;
    if (previousBuildCmd === undefined) delete process.env.E2E_ENTERPRISE_ADMIN_BUILD_COMMAND;
    else process.env.E2E_ENTERPRISE_ADMIN_BUILD_COMMAND = previousBuildCmd;
    delete process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL;
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  const extractRunToken = (error: unknown): string | undefined => {
    if (error && typeof error === 'object' && 'runToken' in error) {
      return (error as { runToken?: string }).runToken;
    }
    if (error instanceof AggregateError) {
      for (const inner of error.errors) {
        const t = extractRunToken(inner);
        if (t) return t;
      }
    }
    return undefined;
  };

  it('cleans owned resources when fault injected at after-postgres', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-postgres';
    let runToken: string | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      runToken = extractRunToken(error);
    }
    expect(runToken).toBeTruthy();
    expect(await listContainersByRunToken(runToken!)).toEqual([]);
  }, 90_000);

  it('cleans owned resources when fault injected at after-redis', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-redis';
    let runToken: string | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      runToken = extractRunToken(error);
    }
    expect(runToken).toBeTruthy();
    expect(await listContainersByRunToken(runToken!)).toEqual([]);
  }, 90_000);

  it('cleans owned resources when fault injected at after-migrate', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-migrate';
    let runToken: string | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      runToken = extractRunToken(error);
    }
    expect(runToken).toBeTruthy();
    expect(await listContainersByRunToken(runToken!)).toEqual([]);
  }, 180_000);

  it('after-build executes verifiable build command then cleans (no SKIP_BUILD)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-build-seam-'));
    tempDirs.push(dir);
    const marker = path.join(dir, 'build-ok');
    // Real shell command that must complete successfully before fault injection.
    process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
    delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    process.env.E2E_ENTERPRISE_ADMIN_BUILD_COMMAND = `printf 'built' > '${marker}' && test -s '${marker}'`;
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-build';

    let runToken: string | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      runToken = extractRunToken(error);
    }
    expect(runToken).toBeTruthy();
    // Build seam completed before fault
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('built');
    expect(await listContainersByRunToken(runToken!)).toEqual([]);
    const suffix = runToken!.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
    expect(existsSync(path.join(PROJECT_ROOT, `.next-e2e-admin-${suffix}`))).toBe(false);
  }, 180_000);

  it('cleans owned resources when fault injected at after-app-spawn', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = 'after-app-spawn';
    let runToken: string | undefined;
    try {
      await startEnterpriseAdminRuntime();
      throw new Error('expected start to fail');
    } catch (error) {
      expect(String(error)).toMatch(/injected startup fault/);
      runToken = extractRunToken(error);
    }
    expect(runToken).toBeTruthy();
    expect(await listContainersByRunToken(runToken!)).toEqual([]);
  }, 240_000);
});
