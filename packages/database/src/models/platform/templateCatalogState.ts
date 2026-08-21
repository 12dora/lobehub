import { eq } from 'drizzle-orm';

import {
  type PlatformTemplateCatalogDomain,
  platformTemplateCatalogState,
  type PlatformTemplateCatalogStateItem,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type { PlatformTemplateCatalogDomain, PlatformTemplateCatalogStateItem };

/**
 * Reads and writes {@link platformTemplateCatalogState}.
 *
 * One row per catalog domain. Presence of the row is the "already seeded" signal:
 * an empty template table with a marker must not be re-seeded.
 */
export class PlatformTemplateCatalogStateModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  findSeeded = async (
    domain: PlatformTemplateCatalogDomain,
  ): Promise<PlatformTemplateCatalogStateItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformTemplateCatalogState)
      .where(eq(platformTemplateCatalogState.domain, domain))
      .limit(1);
    return row;
  };

  /**
   * Record that this catalog is now platform-managed. Idempotent: a concurrent
   * inserter of the same domain keeps the winner's locale / actor.
   */
  markSeeded = async (params: {
    domain: PlatformTemplateCatalogDomain;
    seededBy?: string | null;
    seededLocale: string;
  }): Promise<PlatformTemplateCatalogStateItem> => {
    const [inserted] = await this.db
      .insert(platformTemplateCatalogState)
      .values({
        domain: params.domain,
        seededBy: params.seededBy ?? null,
        seededLocale: params.seededLocale,
      })
      .onConflictDoNothing({ target: platformTemplateCatalogState.domain })
      .returning();
    if (inserted) return inserted;

    const existing = await this.findSeeded(params.domain);
    if (!existing) {
      throw new Error(`Failed to mark template catalog seeded: ${params.domain}`);
    }
    return existing;
  };
}
