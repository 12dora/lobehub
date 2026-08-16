// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { PlatformBrandingPublishedRow } from '@/database/repositories/platformBranding';
import { platformBranding } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
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
  themeDefaults: null,
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
      desktop: { privateBuildInstruction: true },
      emailSenderName: 'AIHub Mail',
      logoUrl: '/aihub.png',
      revision: 7,
      status: 'published',
      themeDefaults: { primaryColor: '#e4002b', privateAdminValue: true },
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
    // Only the theme keys the public contract knows about survive the jsonb column — an
    // unknown key beside a good colour is dropped, never allowed to void the colour.
    expect(branding?.themeDefaults).toEqual({ primaryColor: '#e4002b' });
    expect(branding).not.toHaveProperty('desktop');
    expect(branding).not.toHaveProperty('audit');
    expect(branding).not.toHaveProperty('admin');
    expect(branding).not.toHaveProperty('id');
  });

  it('publishes the stored primary colour and drops an unusable one', async () => {
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockResolvedValueOnce({ ...publishedRow(1), themeDefaults: { primaryColor: '#E4002B' } })
      .mockResolvedValueOnce({ ...publishedRow(2), themeDefaults: { primaryColor: 'red' } });
    let epoch = '0';
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => epoch,
      model: { getPublished },
    });

    await expect(service.getPublished()).resolves.toMatchObject({
      themeDefaults: { primaryColor: '#E4002B' },
    });

    epoch = '1';
    await expect(service.getPublished()).resolves.toMatchObject({
      themeDefaults: { primaryColor: null },
    });
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

  it('reports only real database materializations and never refreshes state on a cache hit', async () => {
    let epoch = '0';
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockResolvedValueOnce(publishedRow(1))
      .mockResolvedValueOnce(publishedRow(2));
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => epoch,
      model: { getPublished },
      reportRuntimeState,
    });

    await expect(service.getPublished()).resolves.toMatchObject({ revision: '1' });
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '1' });
    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(reportRuntimeState).toHaveBeenLastCalledWith(serverDB, {
      domain: 'branding',
      health: 'healthy',
      revision: 1,
      source: 'database',
    });

    epoch = '1';
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '2' });
    expect(reportRuntimeState).toHaveBeenCalledTimes(2);
    expect(reportRuntimeState).toHaveBeenLastCalledWith(serverDB, {
      domain: 'branding',
      health: 'healthy',
      revision: 2,
      source: 'database',
    });
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

  it('reports missing Published branding as unavailable without inventing healthy fallback state', async () => {
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished: vi.fn(async () => undefined) },
      reportRuntimeState,
    });

    await expect(service.getPublished()).resolves.toBeNull();
    await expect(service.getPublished()).resolves.toBeNull();

    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(reportRuntimeState).toHaveBeenCalledWith(serverDB, {
      domain: 'branding',
      errorCategory: 'load_failed',
      health: 'unavailable',
      source: 'unavailable',
    });
    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['unavailable']);
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

  it('reports a real load failure then same-target recovery without changing the thrown error', async () => {
    const original = Object.assign(new Error('raw database detail'), { code: 'ECONNREFUSED' });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const getPublished = vi
      .fn<() => Promise<PlatformBrandingPublishedRow | undefined>>()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(publishedRow(3));
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished },
      reportRuntimeState,
    });

    await expect(service.getPublished()).rejects.toBe(original);
    await expect(service.getPublished()).resolves.toMatchObject({ revision: '3' });

    expect(reportRuntimeState.mock.calls.map(([, state]) => state)).toEqual([
      {
        domain: 'branding',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        source: 'unavailable',
      },
      { domain: 'branding', health: 'healthy', revision: 3, source: 'database' },
    ]);
  });

  it('contains an injected reporter failure and returns the original branding projection', async () => {
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>(() => {
      throw new Error('raw reporter detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BrandingPublishedReadService(serverDB, {
      cacheKey: {},
      getCacheEpoch: async () => '0',
      model: { getPublished: vi.fn(async () => publishedRow(4)) },
      reportRuntimeState,
    });

    await expect(service.getPublished()).resolves.toMatchObject({ revision: '4' });
    expect(consoleError).toHaveBeenCalledWith('[platform-instance-runtime] reporter unavailable');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw reporter detail');
    consoleError.mockRestore();
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
