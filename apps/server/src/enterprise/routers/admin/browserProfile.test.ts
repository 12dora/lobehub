// @vitest-environment node
import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import {
  IMPERSONATE_CHROME_PROFILES,
  LOCALE_BUNDLES,
} from '@lobechat/model-runtime/browserProfile';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import { platformAuditLogs, platformBrowserProfiles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { PlatformBrowserProfileService } from '../../services/browserProfile';
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
    await expect(denied.options()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
    await expect(denied.regenerate({ reason: 'must not run' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
    await expect(
      denied.update({
        chromeId: 'chrome150',
        computeId: 'x',
        localeId: 'x',
        screenId: 'x',
        systemId: 'x',
        webglId: 'x',
      }),
    ).rejects.toMatchObject({
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

  it('returns pool-derived options and selected ids after regenerate', async () => {
    const caller = await callerFor('superAdmin');
    const options = await caller.options();
    const summary = await caller.regenerate({});

    expect(options.chrome.map((item) => item.impersonateProfile)).toEqual(
      IMPERSONATE_CHROME_PROFILES.map((item) => item.id),
    );
    expect(options.locales).toHaveLength(LOCALE_BUNDLES.length);
    expect(summary.chromeId).toEqual(expect.any(String));
    expect(summary.systemId).toEqual(expect.any(String));
    expect(summary.localeId).toEqual(expect.any(String));
    expect(summary.screenId).toEqual(expect.any(String));
    expect(summary.computeId).toEqual(expect.any(String));
    expect(summary.webglId).toEqual(expect.any(String));
    expect(options.chrome.some((item) => item.id === summary.chromeId)).toBe(true);
    expect(options.systems.some((item) => item.id === summary.systemId)).toBe(true);
  });

  it('updates a compatible selection and preserves installation identity', async () => {
    const caller = await callerFor('superAdmin');
    const beforeSummary = await caller.get();
    const [before] = await db.select().from(platformBrowserProfiles);
    const options = await caller.options();
    const nextLocale = options.locales.find((item) => item.id !== beforeSummary.localeId);

    expect(beforeSummary.chromeId && nextLocale).toBeTruthy();

    const summary = await caller.update({
      chromeId: beforeSummary.chromeId!,
      computeId: beforeSummary.computeId!,
      localeId: nextLocale!.id,
      screenId: beforeSummary.screenId!,
      systemId: beforeSummary.systemId!,
      webglId: beforeSummary.webglId!,
    });

    const [after] = await db.select().from(platformBrowserProfiles);
    expect(asBrowserProfile(after.profile).installationId).toBe(
      asBrowserProfile(before.profile).installationId,
    );
    expect(after.seed).toBe(before.seed);
    expect(after.profile.id).toBe(before.profile.id);
    expect(summary.localeId).toBe(nextLocale!.id);
    expect(summary.timezone).toBe(nextLocale!.timezone);

    const audits = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.actorUserId, fixture.actors.superAdmin));
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'system.browser_profile.update',
        afterDiff: expect.objectContaining({
          identityRotated: false,
          localeId: nextLocale!.id,
        }),
      }),
    );
    expect(JSON.stringify(audits)).not.toContain(after.seed);
  });

  it('surfaces a CAS conflict as its own error, not temporarily unavailable', async () => {
    const caller = await callerFor('superAdmin');
    const summary = await caller.get();
    const spy = vi
      .spyOn(PlatformBrowserProfileService.prototype, 'update')
      .mockRejectedValue(
        new PlatformRevisionConflictError('Platform browser profile revision conflict'),
      );

    try {
      const rejected = await caller
        .update({
          chromeId: summary.chromeId!,
          computeId: summary.computeId!,
          localeId: summary.localeId!,
          screenId: summary.screenId!,
          systemId: summary.systemId!,
          webglId: summary.webglId!,
        })
        .catch((error: unknown) => error);

      expect(rejected).toMatchObject({
        code: 'CONFLICT',
        message: 'Platform browser profile was changed by another operator',
      });
      expect(getEnterpriseErrorBody(rejected)?.code).toBe('PLATFORM_REVISION_CONFLICT');
      expect(String((rejected as { message?: string }).message)).not.toContain(
        'temporarily unavailable',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('maps an unknown option id to invalid input without writing', async () => {
    const caller = await callerFor('superAdmin');
    const [before] = await db.select().from(platformBrowserProfiles);
    const summary = await caller.get();

    await expect(
      caller.update({
        chromeId: 'not-a-real-chrome',
        computeId: summary.computeId!,
        localeId: summary.localeId!,
        screenId: summary.screenId!,
        systemId: summary.systemId!,
        webglId: summary.webglId!,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const [after] = await db.select().from(platformBrowserProfiles);
    expect(after).toEqual(before);
  });
});
