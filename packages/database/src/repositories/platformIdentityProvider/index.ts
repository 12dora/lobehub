import { asc, eq } from 'drizzle-orm';

import {
  type NewPlatformIdentityProvider,
  type PlatformIdentityProviderItem,
  platformIdentityProviders,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

/** Persistence boundary for external login provider drafts. */
export class PlatformIdentityProviderRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  create = async (values: NewPlatformIdentityProvider): Promise<PlatformIdentityProviderItem> => {
    const [row] = await this.db.insert(platformIdentityProviders).values(values).returning();
    return row;
  };

  get = async (id: string): Promise<PlatformIdentityProviderItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, id))
      .limit(1);
    return row;
  };

  getByKey = async (providerKey: string): Promise<PlatformIdentityProviderItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.providerKey, providerKey))
      .limit(1);
    return row;
  };

  list = async (): Promise<PlatformIdentityProviderItem[]> =>
    this.db
      .select()
      .from(platformIdentityProviders)
      .orderBy(asc(platformIdentityProviders.providerKey));
}
