import debug from 'debug';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';
import type { PlatformBrandingPublished } from '@/types/platform/branding';

import { buildPlatformPublicSnapshot } from '../platformPublicSnapshot';
import { BrandingPublishedReadService } from './publishedReadService';

const log = debug('lobe-server:platform-public-snapshot');

export interface ResolvePlatformPublicSnapshotOptions {
  flags: EnterpriseFeatureFlags;
  getDatabase?: () => Promise<LobeChatDatabase>;
  getPublishedBranding?: (db: LobeChatDatabase) => Promise<PlatformBrandingPublished | null>;
}

/** Lazy DB boundary keeps the disabled feature path independent of database availability. */
export const resolvePlatformPublicSnapshot = async ({
  flags,
  getDatabase = getServerDB,
  getPublishedBranding = (db) => new BrandingPublishedReadService(db).getPublished(),
}: ResolvePlatformPublicSnapshotOptions) => {
  if (!flags.ENABLE_RUNTIME_BRANDING) return buildPlatformPublicSnapshot({ flags });

  try {
    const db = await getDatabase();
    const branding = await getPublishedBranding(db);

    return buildPlatformPublicSnapshot({ branding, flags });
  } catch (error) {
    log(
      'published branding unavailable; using built-in fallback (%s)',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return buildPlatformPublicSnapshot({ flags });
  }
};
