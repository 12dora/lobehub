import { PlatformBrandingModel } from '@/database/models/platform';
import type { PlatformBrandingPublishedRow } from '@/database/repositories/platformBranding';
import type { LobeChatDatabase } from '@/database/type';
import {
  type PlatformBrandingPublished,
  platformBrandingPublishedSchema,
} from '@/types/platform/branding';

import { DomainConfigCache, invalidateDomainConfigCacheNamespace } from '../../runtimeConfig';
import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';

const BRANDING_CACHE_SCOPE = 'branding';
const BRANDING_CACHE_ID = 'published';
const BRANDING_CACHE_NAMESPACE = 'branding-published';

interface PublishedBrandingReader {
  getPublished: () => Promise<PlatformBrandingPublishedRow | undefined>;
}

export interface BrandingPublishedReadServiceOptions {
  cacheKey?: object;
  cacheTtlMs?: number;
  getCacheEpoch?: () => Promise<string>;
  model?: PublishedBrandingReader;
  now?: () => number;
}

const clonePublishedBranding = (
  branding: PlatformBrandingPublished,
): PlatformBrandingPublished => ({
  ...branding,
});

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
  private readonly cache: DomainConfigCache<PlatformBrandingPublished>;
  private readonly model: PublishedBrandingReader;

  constructor(db: LobeChatDatabase, options: BrandingPublishedReadServiceOptions = {}) {
    this.model = options.model ?? new PlatformBrandingModel(db);
    this.cache = new DomainConfigCache({
      cacheId: BRANDING_CACHE_ID,
      cacheKey: options.cacheKey ?? db,
      cacheTtlMs: options.cacheTtlMs,
      cloneValue: clonePublishedBranding,
      getScopeEpoch:
        options.getCacheEpoch ?? (() => getPlatformConfigScopeVersion(BRANDING_CACHE_SCOPE)),
      load: async () => {
        const row = await this.model.getPublished();
        return row ? projectPublishedBranding(row) : null;
      },
      namespace: BRANDING_CACHE_NAMESPACE,
      now: options.now,
      observabilityDomain: 'branding',
    });
  }

  getPublished = async (): Promise<PlatformBrandingPublished | null> => this.cache.get();
}

export const resetBrandingPublishedCache = (): void => {
  invalidateDomainConfigCacheNamespace(BRANDING_CACHE_NAMESPACE);
};
