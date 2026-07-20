import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT, startEnterpriseAdminRuntime } from './infrastructure';
import { listContainersByRunToken } from './lifecycle';

/**
 * Real startEnterpriseAdminRuntime fault injection for every awaited stage.
 * From outside each failed start: zero containers for that run-token.
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

  const stages: Array<{
    env?: Record<string, string>;
    stage: 'after-postgres' | 'after-redis' | 'after-migrate' | 'after-build' | 'after-app-spawn';
    timeout: number;
  }> = [
    { stage: 'after-postgres', timeout: 90_000 },
    { stage: 'after-redis', timeout: 90_000 },
    { stage: 'after-migrate', timeout: 180_000 },
    {
      env: {
        E2E_ENTERPRISE_ADMIN_MODE: 'start',
        E2E_ENTERPRISE_ADMIN_SKIP_BUILD: '1',
      },
      stage: 'after-build',
      timeout: 180_000,
    },
    { stage: 'after-app-spawn', timeout: 240_000 },
  ];

  for (const { stage, timeout, env } of stages) {
    it(
      `cleans owned resources when fault injected at ${stage}`,
      async () => {
        process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = stage;
        if (env) {
          for (const [k, v] of Object.entries(env)) process.env[k] = v;
        }

        let runToken: string | undefined;
        try {
          await startEnterpriseAdminRuntime();
          throw new Error('expected start to fail');
        } catch (error) {
          expect(String(error)).toMatch(/injected startup fault/);
          runToken = extractRunToken(error);
        }
        expect(runToken, `runToken on fault ${stage}`).toBeTruthy();
        const leftover = await listContainersByRunToken(runToken!);
        expect(leftover).toEqual([]);

        // No owned next distDir residue for this token suffix
        const suffix = runToken!.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
        const dist = path.join(PROJECT_ROOT, `.next-e2e-admin-${suffix}`);
        expect(existsSync(dist)).toBe(false);
      },
      timeout,
    );
  }
});
