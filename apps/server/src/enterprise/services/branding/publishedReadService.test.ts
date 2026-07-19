// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { PlatformBrandingPublishedRow } from '@/database/repositories/platformBranding';
import { platformBranding } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { BrandingPublishedReadService, resetBrandingPublishedCache } from './publishedReadService';

const serverDB: LobeChatDatabase = await getTestDB();

const cleanup = async () => serverDB.delete(platformBranding);

const publishedRow = (revision: number): PlatformBrandingPublishedRow => ({
  defaultAgentDisplayName: null,
  displayName: `Brand ${revision}`,
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  id: `brand-${revision}`,
  legalName: null,
  logoUrl: `/brand-${revision}.png`,
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  revision,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
});

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });

  return { promise, reject, resolve };
};

beforeEach(async () => {
  resetBrandingPublishedCache();
  await cleanup();
});
afterEach(cleanup);

describe('BrandingPublishedReadService', () => {
  it('reads and strictly projects the exact Published database revision', async () => {
    await serverDB.insert(platformBranding).values({
      displayName: 'AIHub',
      emailSenderName: 'AIHub Mail',
      logoUrl: '/aihub.png',
      revision: 7,
      status: 'published',
      themeDefaults: { privateAdminValue: true },
    });

    const branding = await new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
    }).getPublished();

    expect(branding).toMatchObject({
      emailSenderName: 'AIHub Mail',
      logoUrl: '/aihub.png',
      name: 'AIHub',
      revision: '7',
    });
    expect(branding).not.toHaveProperty('themeDefaults');
    expect(branding).not.toHaveProperty('id');
  });

  it('rejects a malicious Published row instead of returning an unsafe snapshot', async () => {
    await serverDB.insert(platformBranding).values({
      displayName: 'Unsafe',
      logoUrl: 'javascript:alert(1)',
      revision: 1,
      status: 'published',
    });

    await expect(
      new BrandingPublishedReadService(serverDB, {
        cacheKey: {},
        getCacheEpoch: async () => '0',
      }).getPublished(),
    ).rejects.toThrow();
  });

  it('caches DB results, then refreshes on scope epoch or bounded TTL changes', async () => {
    let epoch = '0';
    let now = 100;
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockResolvedValueOnce(publishedRow(1))
      .mockResolvedValueOnce(publishedRow(2))
      .mockResolvedValueOnce(publishedRow(3));
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      cacheTtlMs: 50,
      getCacheEpoch: async () => epoch,
      model: { getPublished },
      now: () => now,
    });

    await expect(service.getPublished()).resolves.toMatchObject({ revision: '1' });
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '1' });
    expect(getPublished).toHaveBeenCalledTimes(1);

    epoch = '1';
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '2' });
    expect(getPublished).toHaveBeenCalledTimes(2);

    now = 151;
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '3' });
    expect(getPublished).toHaveBeenCalledTimes(3);
  });

  it('caches the absence of Published branding without inventing a revision', async () => {
    const getPublished = vi.fn(async () => undefined);
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished },
    });

    await expect(service.getPublished()).resolves.toBeNull();
    await expect(service.getPublished()).resolves.toBeNull();
    expect(getPublished).toHaveBeenCalledOnce();
  });

  it('shares one cold-miss read for concurrent callers with the same cache key and epoch', async () => {
    const pending = deferred<PlatformBrandingPublishedRow | undefined>();
    const getPublished = vi.fn(() => pending.promise);
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished },
    });

    const first = service.getPublished();
    const second = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledOnce());
    pending.resolve(publishedRow(1));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ revision: '1' }),
      expect.objectContaining({ revision: '1' }),
    ]);
    expect(getPublished).toHaveBeenCalledOnce();
  });

  it('does not let a slow old epoch overwrite a newer completed cache value', async () => {
    let epoch = 'old';
    const oldRead = deferred<PlatformBrandingPublishedRow | undefined>();
    const newRead = deferred<PlatformBrandingPublishedRow | undefined>();
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => epoch,
      model: { getPublished },
    });

    const oldRequest = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledOnce());
    epoch = 'new';
    const newRequest = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledTimes(2));

    newRead.resolve(publishedRow(2));
    await expect(newRequest).resolves.toMatchObject({ revision: '2' });
    oldRead.resolve(publishedRow(1));
    await expect(oldRequest).resolves.toMatchObject({ revision: '1' });

    await expect(service.getPublished()).resolves.toMatchObject({ revision: '2' });
    expect(getPublished).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent failures without caching them and permits a clean retry', async () => {
    const failedRead = deferred<PlatformBrandingPublishedRow | undefined>();
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockReturnValueOnce(failedRead.promise)
      .mockResolvedValueOnce(publishedRow(2));
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished },
    });

    const first = service.getPublished();
    const second = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledOnce());
    failedRead.reject(new Error('database unavailable'));

    const failures = await Promise.allSettled([first, second]);
    expect(failures.every((result) => result.status === 'rejected')).toBe(true);
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '2' });
    expect(getPublished).toHaveBeenCalledTimes(2);
  });

  it('reset clears cached and in-flight state without an old request deleting new work', async () => {
    const cacheKey = {};
    const oldRead = deferred<PlatformBrandingPublishedRow | undefined>();
    const newRead = deferred<PlatformBrandingPublishedRow | undefined>();
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey,
      getCacheEpoch: async () => '0',
      model: { getPublished },
    });

    const beforeReset = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledOnce());
    resetBrandingPublishedCache();
    const afterReset = service.getPublished();
    await vi.waitFor(() => expect(getPublished).toHaveBeenCalledTimes(2));

    oldRead.resolve(publishedRow(1));
    await expect(beforeReset).resolves.toMatchObject({ revision: '1' });
    const sharedAfterReset = service.getPublished();
    await Promise.resolve();
    expect(getPublished).toHaveBeenCalledTimes(2);

    newRead.resolve(publishedRow(2));
    await expect(Promise.all([afterReset, sharedAfterReset])).resolves.toEqual([
      expect.objectContaining({ revision: '2' }),
      expect.objectContaining({ revision: '2' }),
    ]);
    expect(getPublished).toHaveBeenCalledTimes(2);
  });
});
