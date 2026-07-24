import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  platformCatalogAuthority,
  type PlatformCatalogAuthorityDomain,
} from '../../schemas/platform/catalogAuthority';
import type { LobeChatDatabase, Transaction } from '../../type';

export type { PlatformCatalogAuthorityDomain };

export interface CatalogAuthorityGenerationRow {
  generation: number;
  tokenKind: string;
  tokenValue: string;
}

const ZERO_TOKEN = '0'.repeat(64);

const absentGeneration = (): CatalogAuthorityGenerationRow => ({
  generation: 0,
  tokenKind: 'immutable_id',
  tokenValue: ZERO_TOKEN,
});

const asRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
};

const newTokenStamp = (): string => randomBytes(32).toString('hex');

/**
 * Multi-instance catalog authority generation store.
 *
 * Table DDL lives exclusively in migration 0154 — this model is pure DML so
 * least-privilege app roles (no schema CREATE) can publish.
 *
 * {@link peekGeneration} is a single primary-key read (O(1)).
 * {@link bumpGeneration} advances generation atomically and is safe inside a publish transaction.
 */
export class PlatformCatalogAuthorityModel {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  /**
   * Cheap PK read of one domain row. Returns generation 0 when the **row** is absent
   * (benign seed gap: insert-on-bump will create it). Relation-missing / permission
   * errors are **not** swallowed — migration 0154 must be applied.
   */
  async peekGeneration(
    domain: PlatformCatalogAuthorityDomain,
  ): Promise<CatalogAuthorityGenerationRow> {
    const [row] = await this.db
      .select({
        generation: platformCatalogAuthority.generation,
        tokenKind: platformCatalogAuthority.tokenKind,
        tokenValue: platformCatalogAuthority.tokenValue,
      })
      .from(platformCatalogAuthority)
      .where(eq(platformCatalogAuthority.domain, domain))
      .limit(1);

    if (!row) return absentGeneration();

    const generation = Number(row.generation);
    return {
      generation: Number.isFinite(generation) && generation >= 0 ? generation : 0,
      tokenKind: row.tokenKind,
      tokenValue: row.tokenValue,
    };
  }

  /**
   * Atomically advance `generation` by 1 and store a fresh token stamp.
   * Safe to call inside an open publish/rollback transaction (`tx`).
   *
   * Pure DML: INSERT … ON CONFLICT DO UPDATE (no CREATE TABLE / DDL).
   * A missing seed row still advances correctly; a missing **relation** surfaces as a real error.
   * Token stamp is generated in JS (PGlite-safe; no extension-dependent SQL).
   */
  async bumpGeneration(
    domain: PlatformCatalogAuthorityDomain,
  ): Promise<CatalogAuthorityGenerationRow> {
    const tokenValue = newTokenStamp();
    const result = await this.db.execute(sql`
      INSERT INTO platform_catalog_authority AS pca (
        domain,
        generation,
        token_kind,
        token_value,
        updated_at
      )
      VALUES (
        ${domain},
        1,
        'immutable_id',
        ${tokenValue},
        now()
      )
      ON CONFLICT (domain) DO UPDATE SET
        generation = pca.generation + 1,
        token_kind = 'immutable_id',
        token_value = EXCLUDED.token_value,
        updated_at = now()
      RETURNING generation, token_kind, token_value
    `);

    const rows = asRows<{
      generation: number | string;
      token_kind: string;
      token_value: string;
    }>(result);
    const row = rows[0];
    if (!row) {
      throw new Error('PLATFORM_CATALOG_AUTHORITY_BUMP_FAILED');
    }
    const generation = Number(row.generation);
    if (!Number.isFinite(generation) || generation <= 0) {
      throw new Error('PLATFORM_CATALOG_AUTHORITY_BUMP_FAILED');
    }
    return {
      generation,
      tokenKind: row.token_kind,
      tokenValue: row.token_value,
    };
  }
}
