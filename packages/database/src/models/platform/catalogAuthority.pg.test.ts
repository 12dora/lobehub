/**
 * Persisted catalog-authority generation path.
 *
 * Prefer TEST_SERVER_DB=1 + DATABASE_TEST_URL for real Postgres; otherwise
 * getTestDB() applies migration 0154 on PGlite (still pure DML, no runtime DDL).
 *
 * No runtime CREATE TABLE — relies exclusively on migration 0154 DDL.
 *
 * @vitest-environment node
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformCatalogAuthority } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformCatalogAuthorityModel } from './catalogAuthority';

const db: LobeChatDatabase = await getTestDB();
const isServerDb = process.env.TEST_SERVER_DB === '1';

/** Reset seed rows only — never CREATE TABLE (migration 0154 owns DDL). */
const cleanup = async () => {
  await db.execute(sql`
    INSERT INTO platform_catalog_authority (domain, generation, token_kind, token_value, updated_at)
    VALUES
      ('ai_catalog', 0, 'immutable_id', ${'0'.repeat(64)}, now()),
      ('skill_catalog', 0, 'immutable_id', ${'0'.repeat(64)}, now())
    ON CONFLICT (domain) DO UPDATE SET
      generation = 0,
      token_kind = 'immutable_id',
      token_value = EXCLUDED.token_value,
      updated_at = now()
  `);
};

describe('PlatformCatalogAuthorityModel (persisted path)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('peekGeneration is a single-row PK read and defaults to 0 for seed rows', async () => {
    const model = new PlatformCatalogAuthorityModel(db);
    await expect(model.peekGeneration('ai_catalog')).resolves.toMatchObject({
      generation: 0,
      tokenKind: 'immutable_id',
    });
  });

  it('bumpGeneration is pure DML (no DDL) and advances generation atomically', async () => {
    const model = new PlatformCatalogAuthorityModel(db);
    const first = await model.bumpGeneration('ai_catalog');
    expect(first.generation).toBe(1);
    expect(first.tokenValue).toMatch(/^[a-f0-9]{64}$/);

    const second = await model.bumpGeneration('ai_catalog');
    expect(second.generation).toBe(2);
    expect(second.tokenValue).not.toBe(first.tokenValue);

    await expect(model.peekGeneration('ai_catalog')).resolves.toMatchObject({
      generation: 2,
      tokenValue: second.tokenValue,
    });

    // skill domain is independent
    await expect(model.bumpGeneration('skill_catalog')).resolves.toMatchObject({ generation: 1 });
    await expect(model.peekGeneration('ai_catalog')).resolves.toMatchObject({ generation: 2 });
  });

  it('bumpGeneration commits with surrounding work and rolls back with the transaction', async () => {
    const model = new PlatformCatalogAuthorityModel(db);
    await model.bumpGeneration('ai_catalog'); // → 1

    // Commit path: bump + sibling write land together.
    await db.transaction(async (tx) => {
      await new PlatformCatalogAuthorityModel(tx).bumpGeneration('ai_catalog'); // → 2
      await tx
        .update(platformCatalogAuthority)
        .set({ tokenKind: 'immutable_id' })
        .where(sql`domain = 'skill_catalog'`);
    });
    await expect(model.peekGeneration('ai_catalog')).resolves.toMatchObject({ generation: 2 });

    // Rollback path: in-tx bump must not persist.
    await expect(
      db.transaction(async (tx) => {
        await new PlatformCatalogAuthorityModel(tx).bumpGeneration('ai_catalog'); // → 3 in-tx
        throw new Error('force_rollback');
      }),
    ).rejects.toThrow('force_rollback');

    await expect(model.peekGeneration('ai_catalog')).resolves.toMatchObject({ generation: 2 });
  });

  it('independent model instances (second process) observe the bumped generation', async () => {
    const writer = new PlatformCatalogAuthorityModel(db);
    const reader = new PlatformCatalogAuthorityModel(db);

    await writer.bumpGeneration('skill_catalog');
    await writer.bumpGeneration('skill_catalog');

    await expect(reader.peekGeneration('skill_catalog')).resolves.toMatchObject({
      generation: 2,
    });
  });

  it('surfaces real relation-missing errors (does not swallow 42P01)', async () => {
    // RENAME inside a transaction is most reliable on real Postgres.
    if (!isServerDb) return;

    await db.transaction(async (tx) => {
      // Local rename so the model path hits a missing relation without dropping production DDL.
      await tx.execute(
        sql`ALTER TABLE platform_catalog_authority RENAME TO platform_catalog_authority_hidden`,
      );
      try {
        await expect(
          new PlatformCatalogAuthorityModel(tx).peekGeneration('ai_catalog'),
        ).rejects.toThrow();
        await expect(
          new PlatformCatalogAuthorityModel(tx).bumpGeneration('ai_catalog'),
        ).rejects.toThrow();
      } finally {
        await tx.execute(
          sql`ALTER TABLE platform_catalog_authority_hidden RENAME TO platform_catalog_authority`,
        );
      }
    });
  });
});
