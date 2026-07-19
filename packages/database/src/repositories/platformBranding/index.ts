import { desc, eq } from 'drizzle-orm';

import { platformBranding } from '../../schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface PlatformBrandingPublishedRow {
  defaultAgentDisplayName: string | null;
  displayName: string | null;
  emailFrom: string | null;
  emailSenderName: string | null;
  faviconUrl: string | null;
  homeUrl: string | null;
  iconUrl: string | null;
  id: string;
  legalName: string | null;
  logoUrl: string | null;
  ogImageUrl: string | null;
  pageTitleTemplate: string | null;
  privacyUrl: string | null;
  revision: number;
  shortName: string | null;
  supportUrl: string | null;
  termsUrl: string | null;
}

/** Persistence projection for the anonymous branding read path. */
export class PlatformBrandingRepository {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  listPublished = async (): Promise<PlatformBrandingPublishedRow[]> => {
    return this.db
      .select({
        defaultAgentDisplayName: platformBranding.defaultAgentDisplayName,
        displayName: platformBranding.displayName,
        emailFrom: platformBranding.emailFrom,
        emailSenderName: platformBranding.emailSenderName,
        faviconUrl: platformBranding.faviconUrl,
        homeUrl: platformBranding.homeUrl,
        iconUrl: platformBranding.iconUrl,
        id: platformBranding.id,
        legalName: platformBranding.legalName,
        logoUrl: platformBranding.logoUrl,
        ogImageUrl: platformBranding.ogImageUrl,
        pageTitleTemplate: platformBranding.pageTitleTemplate,
        privacyUrl: platformBranding.privacyUrl,
        revision: platformBranding.revision,
        shortName: platformBranding.shortName,
        supportUrl: platformBranding.supportUrl,
        termsUrl: platformBranding.termsUrl,
      })
      .from(platformBranding)
      .where(eq(platformBranding.status, 'published'))
      .orderBy(desc(platformBranding.revision), desc(platformBranding.updatedAt))
      .limit(2);
  };
}
