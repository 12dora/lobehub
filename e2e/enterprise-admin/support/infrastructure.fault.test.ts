import { afterEach, describe, expect, it } from 'vitest';

import { startEnterpriseAdminRuntime } from './infrastructure';
import { listContainersByRunToken } from './lifecycle';

/**
 * Injected faults at each awaited startup stage via E2E_ENTERPRISE_ADMIN_FAULT_STAGE.
 * startEnterpriseAdminRuntime must clean owned containers on every failure path.
 */
describe('startEnterpriseAdminRuntime fault injection cleanup', () => {
  const previous = process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE;
    } else {
      process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = previous;
    }
    delete process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL;
  });

  for (const stage of ['after-postgres', 'after-redis'] as const) {
    it(`cleans owned containers when fault injected at ${stage}`, async () => {
      process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE = stage;
      let runToken: string | undefined;
      try {
        await startEnterpriseAdminRuntime();
        throw new Error('expected start to fail');
      } catch (error) {
        expect(String(error)).toMatch(/injected startup fault/);
        runToken = (error as { runToken?: string }).runToken;
        // AggregateError may wrap the injected fault
        if (!runToken && error instanceof AggregateError) {
          for (const inner of error.errors) {
            if (inner && typeof inner === 'object' && 'runToken' in inner) {
              runToken = (inner as { runToken?: string }).runToken;
            }
          }
        }
      }
      expect(runToken, 'runToken must be attached to injected fault').toBeTruthy();
      const leftover = await listContainersByRunToken(runToken!);
      expect(leftover).toEqual([]);
    }, 120_000);
  }
});
