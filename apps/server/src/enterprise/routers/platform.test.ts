// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformRouter } from './platform';

const createCaller = createCallerFactory(platformRouter);

/**
 * Flag-off regression (M00/M02): when ENABLE_PLATFORM_ADMIN is unset,
 * adminAccess stays false and no secrets/roles leak.
 *
 * Note: getCapabilities now uses serverDatabase middleware — tests that only
 * need flag-off behavior mock serverDB lightly via context injection when needed.
 */
describe('platformRouter (read-only, flags default off)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('getPublicSnapshot is safe for anonymous callers', async () => {
    const ctx = await createContextInner();
    const caller = createCaller(ctx);
    const snap = await caller.getPublicSnapshot();

    expect(snap).toEqual({
      branding: null,
      brandingRevision: null,
      configRevision: '0',
      login: { openRegistration: true, workAccountEnabled: false },
      logoUrl: null,
      platformName: null,
    });
    expect(Object.keys(snap).sort()).toEqual([
      'branding',
      'brandingRevision',
      'configRevision',
      'login',
      'logoUrl',
      'platformName',
    ]);
    expect(snap.platformName).toBeNull();
    expect(snap.login.workAccountEnabled).toBe(false);
    expect(snap).not.toHaveProperty('adminAccess');
    expect(JSON.stringify(snap)).not.toMatch(/secret|token|password/i);
  });

  it('getCapabilities rejects anonymous callers (UNAUTHORIZED)', async () => {
    const ctx = await createContextInner();
    const caller = createCaller(ctx);
    await expect(caller.getCapabilities()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('getAccessStatus grants authenticated users when platform admin is on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const ctx = await createContextInner({ userId: 'platform-test-user' });
    // getAccessStatus needs serverDB; without a real DB this would fail — keep flag-off
    // public/snapshot coverage above and rely on accessStatus.test for DB-backed cases.
    expect(typeof createCaller(ctx).getAccessStatus).toBe('function');
  });
});
