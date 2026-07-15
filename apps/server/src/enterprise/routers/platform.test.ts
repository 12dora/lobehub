// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformRouter } from './platform';

const createCaller = createCallerFactory(platformRouter);

describe('platformRouter (read-only, flags default off)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('getCapabilities returns disabled snapshot with no secrets/roles', async () => {
    const ctx = await createContextInner({ userId: 'user-1' });
    const caller = createCaller(ctx);
    const caps = await caller.getCapabilities();

    expect(caps.adminAccess).toBe(false);
    expect(caps.features.platformAdmin).toBe(false);
    expect(caps.configRevision).toBe('0');
    expect(caps).not.toHaveProperty('roles');
    expect(caps).not.toHaveProperty('permissions');
    expect(JSON.stringify(caps)).not.toMatch(/secret|token|password|apiKey/i);
  });

  it('getPublicSnapshot is safe for anonymous callers', async () => {
    const ctx = await createContextInner();
    const caller = createCaller(ctx);
    const snap = await caller.getPublicSnapshot();

    expect(snap.platformName).toBeNull();
    expect(snap.login.workAccountEnabled).toBe(false);
    expect(snap).not.toHaveProperty('adminAccess');
    expect(JSON.stringify(snap)).not.toMatch(/secret|token|password/i);
  });

  it('reflects ENABLE_PLATFORM_ADMIN in features.platformAdmin without adminAccess', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const ctx = await createContextInner({ userId: 'admin-candidate' });
    const caller = createCaller(ctx);
    const caps = await caller.getCapabilities();

    expect(caps.features.platformAdmin).toBe(true);
    // No M02 RBAC → still false
    expect(caps.adminAccess).toBe(false);
  });
});
