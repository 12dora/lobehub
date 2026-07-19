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
});
