import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT, startEnterpriseAdminRuntime } from './infrastructure';
import { listContainersByRunToken } from './lifecycle';

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

  const runFault = async (stage: string) => {
    process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = stage;
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
    const suffix = runToken!.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
    expect(existsSync(path.join(PROJECT_ROOT, `.next-e2e-admin-${suffix}`))).toBe(false);
    return runToken!;
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

  it('after-build runs default bun run build then cleans (no SKIP_BUILD, no custom cmd)', async () => {
    process.env.E2E_ENTERPRISE_ADMIN_MODE = 'start';
    delete process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD;
    await runFault('after-build');
  }, 1_200_000); // real SPA+auth+Next build

  it('after-app-spawn cleans owned resources', async () => {
    await runFault('after-app-spawn');
  }, 240_000);
});
