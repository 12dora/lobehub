// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { lambdaRouter } from '../index';

const createCaller = createCallerFactory(lambdaRouter);

/**
 * Flag-off regression for platform mount on lambda root.
 * Default env must yield disabled snapshots without secrets/roles.
 */
describe('lambdaRouter platform mount (flag-off)', () => {
  it('exposes platform.getCapabilities with disabled defaults for authed user', async () => {
    const ctx = await createContextInner({ userId: 'u1' });
    const caller = createCaller(ctx);
    const caps = await caller.platform.getCapabilities();

    expect(caps.adminAccess).toBe(false);
    expect(caps.features.platformAdmin).toBe(false);
    expect(caps).not.toHaveProperty('roles');
    expect(caps).not.toHaveProperty('permissions');
  });

  it('rejects anonymous getCapabilities', async () => {
    const ctx = await createContextInner();
    const caller = createCaller(ctx);
    await expect(caller.platform.getCapabilities()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('exposes platform.getPublicSnapshot for anonymous', async () => {
    const ctx = await createContextInner();
    const caller = createCaller(ctx);
    const snap = await caller.platform.getPublicSnapshot();

    expect(snap.platformName).toBeNull();
    expect(snap.login.workAccountEnabled).toBe(false);
  });
});
