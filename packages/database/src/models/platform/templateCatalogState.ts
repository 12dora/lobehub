import { eq, sql } from 'drizzle-orm';

import { inTransaction } from '../../repositories/platform/tx';
import {
  type PlatformTemplateCatalogDomain,
  platformTemplateCatalogState,
  type PlatformTemplateCatalogStateItem,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type { PlatformTemplateCatalogDomain, PlatformTemplateCatalogStateItem };

/**
 * Catalog-level advisory lock namespace. Every template catalog mutation and the
 * auto-seed path acquire this **before** per-identifier import locks so lock order
 * is always catalog → identifier (no deadlocks).
 */
export const PLATFORM_TEMPLATE_CATALOG_LOCK_NAMESPACE = 'aihub:platform-template-catalog-seed:v1';

/**
 * `seeded_locale` written when the catalog becomes managed without a locale-aware
 * seed (operator create/delete/import, or a migration backfill of a nonempty table).
 * Distinct from a real console locale so auditors can tell a claimed catalog from
 * an auto-seed.
 */
export const PLATFORM_TEMPLATE_CATALOG_LEGACY_LOCALE = 'legacy';

export const platformTemplateCatalogLockKey = (domain: PlatformTemplateCatalogDomain) =>
  `${PLATFORM_TEMPLATE_CATALOG_LOCK_NAMESPACE}:${domain}`;

/**
 * Hold the catalog lock for `work`. Does **not** write the marker — callers claim
 * only after a mutation actually lands (a 404 delete must not freeze an empty catalog).
 */
export const withPlatformTemplateCatalogLock = async <T>(
  db: LobeChatDatabase | Transaction,
  domain: PlatformTemplateCatalogDomain,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  inTransaction(db, async (tx) => {
    await new PlatformTemplateCatalogStateModel(tx).acquireLock(domain);
    return work(tx);
  });

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

  acquireLock = async (domain: PlatformTemplateCatalogDomain): Promise<void> => {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${platformTemplateCatalogLockKey(domain)})::bigint)`,
    );
  };

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
