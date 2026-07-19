import { PlatformBrandingModel } from '@/database/models/platform';
import type { PlatformBrandingPublishedRow } from '@/database/repositories/platformBranding';
import type { LobeChatDatabase } from '@/database/type';
import {
  type PlatformBrandingPublished,
  platformBrandingPublishedSchema,
} from '@/types/platform/branding';

import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';

const BRANDING_CACHE_SCOPE = 'branding';
const DEFAULT_CACHE_TTL_MS = 30_000;

interface PublishedBrandingReader {
  getPublished: () => Promise<PlatformBrandingPublishedRow | undefined>;
}

interface BrandingCacheEntry {
  epoch: string;
  expiresAt: number;
  value: PlatformBrandingPublished | null;
}

export interface BrandingPublishedReadServiceOptions {
  cacheKey?: object;
  cacheTtlMs?: number;
  getCacheEpoch?: () => Promise<string>;
  model?: PublishedBrandingReader;
  now?: () => number;
}

let brandingCache = new WeakMap<object, BrandingCacheEntry>();

const clonePublishedBranding = (
  branding: PlatformBrandingPublished | null,
): PlatformBrandingPublished | null => (branding ? { ...branding } : null);

const projectPublishedBranding = (row: PlatformBrandingPublishedRow): PlatformBrandingPublished => {
  if (!Number.isSafeInteger(row.revision) || row.revision <= 0) {
    throw new Error('Published branding revision must be a positive integer');
  }

  return platformBrandingPublishedSchema.parse({
    defaultAgentDisplayName: row.defaultAgentDisplayName,
    emailFrom: row.emailFrom,
    emailSenderName: row.emailSenderName,
    faviconUrl: row.faviconUrl,
    homeUrl: row.homeUrl,
    iconUrl: row.iconUrl,
    legalName: row.legalName,
    logoUrl: row.logoUrl,
    name: row.displayName,
    ogImageUrl: row.ogImageUrl,
    pageTitleTemplate: row.pageTitleTemplate,
    privacyUrl: row.privacyUrl,
    revision: String(row.revision),
    shortName: row.shortName,
    supportUrl: row.supportUrl,
    termsUrl: row.termsUrl,
  });
};

/** Strict, bounded and invalidation-aware read path for Published branding. */
export class BrandingPublishedReadService {
  private readonly cacheKey: object;
  private readonly cacheTtlMs: number;
  private readonly getCacheEpoch: () => Promise<string>;
  private readonly model: PublishedBrandingReader;
  private readonly now: () => number;

  constructor(db: LobeChatDatabase, options: BrandingPublishedReadServiceOptions = {}) {
    this.cacheKey = options.cacheKey ?? db;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.getCacheEpoch =
      options.getCacheEpoch ?? (() => getPlatformConfigScopeVersion(BRANDING_CACHE_SCOPE));
    this.model = options.model ?? new PlatformBrandingModel(db);
    this.now = options.now ?? Date.now;
  }

  getPublished = async (): Promise<PlatformBrandingPublished | null> => {
    const epoch = await this.getCacheEpoch();
    const cached = brandingCache.get(this.cacheKey);
    const now = this.now();

    if (cached && cached.epoch === epoch && cached.expiresAt > now) {
      return clonePublishedBranding(cached.value);
    }

    const row = await this.model.getPublished();
    const value = row ? projectPublishedBranding(row) : null;

    brandingCache.set(this.cacheKey, {
      epoch,
      expiresAt: now + this.cacheTtlMs,
      value,
    });

    return clonePublishedBranding(value);
  };
}

export const resetBrandingPublishedCache = (): void => {
  brandingCache = new WeakMap<object, BrandingCacheEntry>();
};
