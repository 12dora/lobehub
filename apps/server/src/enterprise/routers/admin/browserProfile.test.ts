// @vitest-environment node
import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformBrowserProfiles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';

import { createAdminAuthorizationFixture } from '../../testing/adminAuthorizationFixture';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'browser-profile' });

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

beforeAll(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await db.delete(platformBrowserProfiles);
  await fixture.setup(db);
});

afterAll(async () => {
  await db.delete(platformBrowserProfiles);
  await fixture.cleanup(db);
  vi.unstubAllEnvs();
});

const callerFor = async (principal: 'normal' | 'superAdmin') => {
  const contexts = await fixture.createContexts(db);
  return createCaller(contexts[principal] as never).browserProfile;
};

const asBrowserProfile = (profile: unknown): BrowserDeviceProfile =>
  profile as BrowserDeviceProfile;

describe('admin.browserProfile', () => {
  it('returns a seed-free summary to an authorized system reader', async () => {
    const summary = await (await callerFor('superAdmin')).get();

    expect(summary).toMatchObject({
      chromeVersion: expect.any(String),
      impersonateProfile: expect.stringMatching(/^chrome\d+$/),
      installationId: expect.stringMatching(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
      ),
      revision: 0,
    });
    expect(summary).not.toHaveProperty('seed');
  });

  it('denies both reads and regeneration before touching the singleton', async () => {
    const denied = await callerFor('normal');
    const [before] = await db.select().from(platformBrowserProfiles);

    await expect(denied.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
    await expect(denied.regenerate({ reason: 'must not run' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });

    const [after] = await db.select().from(platformBrowserProfiles);
    expect(after).toEqual(before);
  });

  it('regenerates once, increments the revision, and records a metadata-only audit event', async () => {
    const caller = await callerFor('superAdmin');
    const [before] = await db.select().from(platformBrowserProfiles);

    const summary = await caller.regenerate({ reason: 'operator-requested refresh' });

    const [after] = await db.select().from(platformBrowserProfiles);
    expect(after.profile.id).not.toBe(before.profile.id);
    expect(asBrowserProfile(after.profile).installationId).not.toBe(
      asBrowserProfile(before.profile).installationId,
    );
    expect(summary.installationId).toBe(asBrowserProfile(after.profile).installationId);
    expect(summary.revision).toBe(before.revision + 1);
    expect(summary).not.toHaveProperty('seed');

    const audits = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.actorUserId, fixture.actors.superAdmin));
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'system.browser_profile.regenerate',
        afterDiff: { revision: before.revision + 1 },
        beforeDiff: { revision: before.revision },
        reason: 'operator-requested refresh',
        result: 'success',
      }),
    );
    expect(JSON.stringify(audits)).not.toContain(after.seed);
  });
});
