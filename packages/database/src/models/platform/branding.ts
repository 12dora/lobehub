import {
  type PlatformBrandingPublishedRow,
  PlatformBrandingRepository,
} from '../../repositories/platformBranding';
import type { LobeChatDatabase } from '../../type';

export class PlatformBrandingPublicationInvariantError extends Error {
  constructor() {
    super('Expected at most one published platform branding row');
    this.name = 'PlatformBrandingPublicationInvariantError';
  }
}

/** Domain model enforcing the singleton published-branding invariant. */
export class PlatformBrandingModel {
  private readonly repository: PlatformBrandingRepository;

  constructor(db: LobeChatDatabase) {
    this.repository = new PlatformBrandingRepository(db);
  }

  getPublished = async (): Promise<PlatformBrandingPublishedRow | undefined> => {
    const rows = await this.repository.listPublished();

    if (rows.length > 1) throw new PlatformBrandingPublicationInvariantError();

    return rows[0];
  };
}
