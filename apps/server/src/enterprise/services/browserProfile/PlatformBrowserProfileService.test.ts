import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import {
  DEFAULT_BROWSER_DEVICE_PROFILE,
  deriveChromiumBrandHeaders,
  generateBrowserDeviceProfile,
  listBrowserProfileOptions,
  resolveBrowserProfileOptionIds,
} from '@lobechat/model-runtime/browserProfile';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import {
  PLATFORM_BROWSER_PROFILE_ID,
  type PlatformBrowserProfileItem,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  BROWSER_PROFILE_MIGRATION_REASON,
  PlatformBrowserProfileService,
} from './PlatformBrowserProfileService';

const mocks = vi.hoisted(() => ({
  auditAppend: vi.fn(),
  resetCookieJars: vi.fn(),
}));

vi.mock('@/server/enterprise/services/platformAudit', () => ({
  PlatformAuditService: class {
    append = mocks.auditAppend;
  },
}));

vi.mock('@/server/enterprise/services/chatgptWeb/transport/cookieJar', () => ({
  resetCookieJars: mocks.resetCookieJars,
}));

interface FakeDatabase {
  db: LobeChatDatabase;
  read: () => PlatformBrowserProfileItem | undefined;
  selectCalls: ReturnType<typeof vi.fn>;
}

interface FakeDatabaseOptions {
  profileRepairConflictWinner?: PlatformBrowserProfileItem;
  revisionConflict?: boolean;
}

const createFakeDatabase = (
  initial?: PlatformBrowserProfileItem,
  options?: FakeDatabaseOptions,
): FakeDatabase => {
  let row = initial;
  let profileRepairConflictPending = !!options?.profileRepairConflictWinner;
  const selectCalls = vi.fn();
  const db = {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (row) return [];
            const now = new Date('2026-08-18T01:00:00.000Z');
            row = {
              createdAt: now,
              id: values.id as string,
              profile: values.profile as PlatformBrowserProfileItem['profile'],
              revision: values.revision as number,
              seed: values.seed as string,
              updatedAt: now,
              updatedBy: null,
            };
            return [row];
          },
        }),
      }),
    })),
    select: vi.fn(() => {
      selectCalls();
      return {
        from: () => ({
          where: () => ({
            limit: () => {
              const result = Promise.resolve(row ? [row] : []) as Promise<
                PlatformBrowserProfileItem[]
              > & { for: () => Promise<PlatformBrowserProfileItem[]> };
              result.for = async () => (row ? [row] : []);
              return result;
            },
          }),
        }),
      };
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(db),
    update: vi.fn(() => ({
      set: (values: Partial<PlatformBrowserProfileItem>) => ({
        where: () => ({
          returning: async () => {
            if (!row) return [];
            if (profileRepairConflictPending && 'profile' in values && !('revision' in values)) {
              profileRepairConflictPending = false;
              row = options?.profileRepairConflictWinner;
              return [];
            }
            if (options?.revisionConflict && 'revision' in values) return [];
            row = { ...row, ...values };
            return [row];
          },
        }),
      }),
    })),
  } as unknown as LobeChatDatabase;

  return { db, read: () => row, selectCalls };
};

const asBrowserProfile = (
  profile: PlatformBrowserProfileItem['profile'] | undefined,
): BrowserDeviceProfile | undefined => profile as BrowserDeviceProfile | undefined;

beforeEach(() => {
  mocks.auditAppend.mockReset();
  mocks.resetCookieJars.mockReset();
});

describe('PlatformBrowserProfileService', () => {
  it('converges concurrent service instances on the first inserted profile', async () => {
    const fake = createFakeDatabase();
    const firstService = new PlatformBrowserProfileService(fake.db);
    const secondService = new PlatformBrowserProfileService(fake.db);

    const [first, second] = await Promise.all([firstService.get(), secondService.get()]);

    // Behavioural: both instances end up on the single persisted identity.
    expect(second).toEqual(first);
    expect(fake.read()?.profile).toEqual(first);
    expect(fake.read()?.revision).toBe(0);
    expect(mocks.auditAppend).not.toHaveBeenCalled();
  });

  it('creates the singleton once and then serves the in-process cache', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);

    const first = await service.get();
    const second = await service.get();

    expect(second).toEqual(first);
    expect(fake.read()).toMatchObject({
      id: PLATFORM_BROWSER_PROFILE_ID,
      profile: first,
      revision: 0,
      seed: first.seed,
    });
    expect(first.installationId).toEqual(expect.stringMatching(/^[\da-f-]{36}$/));
    // The cached read must be served without touching storage again.
    expect(second).toBe(first);
  });

  it('repairs legacy D1 rows with a stable installation id based on the existing profile id', async () => {
    const legacyProfile = { ...DEFAULT_BROWSER_DEVICE_PROFILE };
    delete (legacyProfile as Partial<typeof legacyProfile>).installationId;
    const now = new Date('2026-08-18T01:00:00.000Z');
    const fake = createFakeDatabase({
      createdAt: now,
      id: PLATFORM_BROWSER_PROFILE_ID,
      profile: legacyProfile as PlatformBrowserProfileItem['profile'],
      revision: 7,
      seed: legacyProfile.seed,
      updatedAt: now,
      updatedBy: null,
    });
    const firstService = new PlatformBrowserProfileService(fake.db);
    const secondService = new PlatformBrowserProfileService(fake.db);

    const [first, second] = await Promise.all([firstService.get(), secondService.get()]);

    expect(first.installationId).toBe(legacyProfile.id);
    expect(second.installationId).toBe(legacyProfile.id);
    expect(asBrowserProfile(fake.read()?.profile)?.installationId).toBe(legacyProfile.id);
    expect(fake.read()?.revision).toBe(7);
  });

  it('rereads the winning row when legacy repair loses the revision race', async () => {
    const legacyProfile = { ...DEFAULT_BROWSER_DEVICE_PROFILE };
    delete (legacyProfile as Partial<typeof legacyProfile>).installationId;
    const concurrentProfile = generateBrowserDeviceProfile({ seed: 'concurrent-regenerate' });
    const now = new Date('2026-08-18T01:00:00.000Z');
    const fake = createFakeDatabase(
      {
        createdAt: now,
        id: PLATFORM_BROWSER_PROFILE_ID,
        profile: legacyProfile as PlatformBrowserProfileItem['profile'],
        revision: 7,
        seed: legacyProfile.seed,
        updatedAt: now,
        updatedBy: null,
      },
      {
        profileRepairConflictWinner: {
          createdAt: now,
          id: PLATFORM_BROWSER_PROFILE_ID,
          profile: concurrentProfile,
          revision: 8,
          seed: concurrentProfile.seed,
          updatedAt: now,
          updatedBy: 'admin-1',
        },
      },
    );

    const repaired = await new PlatformBrowserProfileService(fake.db).get();

    expect(repaired.installationId).toBe(concurrentProfile.installationId);
    expect(repaired.seed).toBe(concurrentProfile.seed);
    expect(fake.read()?.revision).toBe(8);
  });

  it('regenerates atomically, increments revision, audits metadata only, and resets jars', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);
    const before = await service.get();

    const summary = await service.regenerate({ actorUserId: 'admin-1', reason: 'rotate device' });

    expect(fake.read()?.profile.id).not.toBe(before.id);
    expect(asBrowserProfile(fake.read()?.profile)?.installationId).not.toBe(before.installationId);
    expect(summary).toMatchObject({ revision: 1 });
    expect(summary.installationId).toBe(asBrowserProfile(fake.read()?.profile)?.installationId);
    expect(summary).not.toHaveProperty('seed');
    expect(mocks.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin-1',
        afterDiff: { revision: 1 },
        beforeDiff: { revision: 0 },
        reason: 'rotate device',
        result: 'success',
      }),
    );
    expect(JSON.stringify(mocks.auditAppend.mock.calls)).not.toContain(fake.read()?.seed);
    expect(mocks.resetCookieJars).toHaveBeenCalledOnce();
  });

  it('uses the stable fallback when storage is unavailable without logging profile data', async () => {
    const error = new Error('database unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = {
      select: () => {
        throw error;
      },
    } as unknown as LobeChatDatabase;

    const profile = await new PlatformBrowserProfileService(db).getOrFallback();

    expect(profile).toBe(DEFAULT_BROWSER_DEVICE_PROFILE);
    // Diagnostics go through the tree's debug() namespace, never console.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps serving a stored profile whose Chrome build left the pool', async () => {
    // Pools rot. An installation must keep the identity it has presented upstream
    // instead of collapsing onto the shared fallback the day a build is retired.
    const stored = generateBrowserDeviceProfile({ seed: 'stored-installation' });
    // Coherent but no longer pooled: a retired build of the SAME major (the
    // cross-field validator must still accept it), on a macOS build outside the pool.
    const retiredBuild = `${stored.chrome.major}.0.1.1`;
    const drifted = {
      ...stored,
      chrome: { ...stored.chrome, fullVersion: retiredBuild },
      platformVersion: stored.platform === 'macOS' ? '10.15.7' : stored.platformVersion,
      ...deriveChromiumBrandHeaders(stored.chrome.major, retiredBuild),
    };
    const now = new Date('2026-08-18T01:00:00.000Z');
    const fake = createFakeDatabase({
      createdAt: now,
      id: PLATFORM_BROWSER_PROFILE_ID,
      profile: drifted as PlatformBrowserProfileItem['profile'],
      revision: 4,
      seed: stored.seed,
      updatedAt: now,
      updatedBy: null,
    });

    const profile = await new PlatformBrowserProfileService(fake.db).get();

    expect(profile).toEqual(drifted);
    expect(fake.read()?.revision).toBe(4);
    expect(mocks.auditAppend).not.toHaveBeenCalled();
    expect(mocks.resetCookieJars).not.toHaveBeenCalled();
  });

  it('migrates a structurally unusable stored profile with a revision bump and an audit', async () => {
    const now = new Date('2026-08-18T01:00:00.000Z');
    const broken = { id: 'not-a-uuid', schemaVersion: 1 };
    const fake = createFakeDatabase({
      createdAt: now,
      id: PLATFORM_BROWSER_PROFILE_ID,
      profile: broken as unknown as PlatformBrowserProfileItem['profile'],
      revision: 4,
      seed: 'stored-seed',
      updatedAt: now,
      updatedBy: 'admin-1',
    });

    const profile = await new PlatformBrowserProfileService(fake.db).get();

    expect(profile.id).toEqual(expect.stringMatching(/^[\da-f-]{36}$/));
    expect(fake.read()?.revision).toBe(5);
    expect(fake.read()?.profile).toEqual(profile);
    expect(fake.read()?.seed).toBe(profile.seed);
    expect(fake.read()?.updatedBy).toBeNull();
    expect(mocks.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        afterDiff: { migrated: true, revision: 5 },
        beforeDiff: { revision: 4 },
        reason: BROWSER_PROFILE_MIGRATION_REASON,
        result: 'success',
      }),
    );
    expect(JSON.stringify(mocks.auditAppend.mock.calls)).not.toContain(profile.seed);
    // The identity changed, so state minted under the old one must go.
    expect(mocks.resetCookieJars).toHaveBeenCalled();
  });

  it('reports selected option ids on a freshly generated profile', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);

    const profile = await service.get();
    const summary = await service.getSummary();
    const expected = resolveBrowserProfileOptionIds(profile);

    expect(summary).toMatchObject(expected);
    expect(Object.values(expected).every(Boolean)).toBe(true);
  });

  it('updates from curated option ids while preserving installation identity', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);
    const before = await service.get();
    const options = listBrowserProfileOptions();
    const currentIds = resolveBrowserProfileOptionIds(before);
    const nextLocale = options.locales.find((item) => item.id !== currentIds.localeId);

    expect(currentIds.chromeId && nextLocale).toBeTruthy();

    const summary = await service.update({
      actorUserId: 'admin-1',
      chromeId: currentIds.chromeId!,
      computeId: currentIds.computeId!,
      localeId: nextLocale!.id,
      screenId: currentIds.screenId!,
      systemId: currentIds.systemId!,
      webglId: currentIds.webglId!,
    });

    const after = asBrowserProfile(fake.read()?.profile);
    expect(after?.installationId).toBe(before.installationId);
    expect(after?.seed).toBe(before.seed);
    expect(fake.read()?.seed).toBe(before.seed);
    expect(after?.id).toBe(before.id);
    expect(after?.timezone.iana).toBe(nextLocale!.timezone);
    expect(summary.localeId).toBe(nextLocale!.id);
    expect(summary.revision).toBe(1);
    expect(mocks.resetCookieJars).not.toHaveBeenCalled();
    expect(mocks.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({
          identityRotated: false,
          localeId: nextLocale!.id,
          revision: 1,
        }),
        beforeDiff: expect.objectContaining({ localeId: currentIds.localeId, revision: 0 }),
      }),
    );
    expect(JSON.stringify(mocks.auditAppend.mock.calls)).not.toContain(before.seed);
  });

  it('rotates profile.id and cookie jars only when UA or impersonation changes', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);
    const before = await service.get();
    const options = listBrowserProfileOptions();
    const currentIds = resolveBrowserProfileOptionIds(before);
    const nextChrome = options.chrome.find((item) => item.id !== currentIds.chromeId);

    expect(currentIds.chromeId && nextChrome).toBeTruthy();

    await service.update({
      actorUserId: 'admin-1',
      chromeId: nextChrome!.id,
      computeId: currentIds.computeId!,
      localeId: currentIds.localeId!,
      screenId: currentIds.screenId!,
      systemId: currentIds.systemId!,
      webglId: currentIds.webglId!,
    });

    const after = asBrowserProfile(fake.read()?.profile);
    expect(after?.installationId).toBe(before.installationId);
    expect(after?.seed).toBe(before.seed);
    expect(after?.id).not.toBe(before.id);
    expect(after?.impersonateProfile).toBe(nextChrome!.impersonateProfile);
    expect(after?.userAgent).not.toBe(before.userAgent);
    expect(mocks.resetCookieJars).toHaveBeenCalledOnce();
  });

  it('rejects an unknown option id and a platform-incompatible combination without writing', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);
    const before = await service.get();
    const snapshot = fake.read();
    const options = listBrowserProfileOptions();
    const currentIds = resolveBrowserProfileOptionIds(before);
    const windows = options.systems.find((item) => item.platform === 'Windows');
    const windowsScreen = options.screens.find((item) => item.platform === 'Windows');
    const windowsCompute = options.compute.find(
      (item) => item.platform === 'Windows' && item.arch === 'x86',
    );
    const macGpu = options.webgl.find((item) => item.platform === 'macOS' && item.arch === 'arm');

    expect(
      windows && windowsScreen && windowsCompute && macGpu && currentIds.chromeId,
    ).toBeTruthy();

    await expect(
      service.update({
        actorUserId: 'admin-1',
        chromeId: 'missing-chrome',
        computeId: currentIds.computeId!,
        localeId: currentIds.localeId!,
        screenId: currentIds.screenId!,
        systemId: currentIds.systemId!,
        webglId: currentIds.webglId!,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_OPTION' });

    await expect(
      service.update({
        actorUserId: 'admin-1',
        chromeId: currentIds.chromeId!,
        computeId: windowsCompute!.id,
        localeId: currentIds.localeId!,
        screenId: windowsScreen!.id,
        systemId: windows!.id,
        webglId: macGpu!.id,
      }),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_OPTIONS' });

    expect(fake.read()).toEqual(snapshot);
    expect(mocks.resetCookieJars).not.toHaveBeenCalled();
    expect(mocks.auditAppend).not.toHaveBeenCalled();
  });

  it('throws a distinguishable revision conflict when CAS loses', async () => {
    const fake = createFakeDatabase(undefined, { revisionConflict: true });
    const service = new PlatformBrowserProfileService(fake.db);
    const before = await service.get();
    const ids = resolveBrowserProfileOptionIds(before);

    await expect(
      service.update({
        actorUserId: 'admin-1',
        chromeId: ids.chromeId!,
        computeId: ids.computeId!,
        localeId: ids.localeId!,
        screenId: ids.screenId!,
        systemId: ids.systemId!,
        webglId: ids.webglId!,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(fake.read()?.revision).toBe(0);
    expect(mocks.resetCookieJars).not.toHaveBeenCalled();
  });

  it('redacts secret-shaped text from the append-only audit reason', async () => {
    const fake = createFakeDatabase();
    const service = new PlatformBrowserProfileService(fake.db);
    await service.get();

    await service.regenerate({
      actorUserId: 'admin-1',
      reason: 'sk-proj-aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY',
    });

    expect(mocks.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({ reason: '[REDACTED]' }),
    );
  });
});
