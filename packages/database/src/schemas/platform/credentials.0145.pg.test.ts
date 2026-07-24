/**
 * Legacy-fixture replay of migration 0145_platform_db_hardening.
 *
 * Builds a pre-0145 shape (uploads PK = file_hash_id, nullable created_by, no opaque id),
 * applies 0145 twice inside an isolated schema (search_path + fully qualified objects),
 * and asserts data transform + schema-scoped constraints / index DEFINITIONS / CHECK
 * expressions / FK cascade behavior + trigger enforcement + idempotency.
 *
 * Gate: TEST_SERVER_DB=1 and DATABASE_TEST_URL (real PostgreSQL).
 * Does not create or modify migration files — only reads/replays existing SQL.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

const migrations = path.join(import.meta.dirname, '../../../migrations');
const hardeningName = '0145_platform_db_hardening';
const hardeningSql = readFileSync(path.join(migrations, `${hardeningName}.sql`), 'utf8');

const SCHEMA = 'audit_r2_0145_replay';

/**
 * Rewrite 0145 so every object (tables, functions, constraint catalog lookups)
 * is bound to the isolated fixture schema. Bare `"public"."users"` FKs are
 * retargeted to the fixture users table; pg_constraint existence checks are
 * schema-scoped so pre-existing `public` objects cannot short-circuit the DO
 * blocks or satisfy assertions.
 */
const qualifyHardeningSql = (sqlText: string, schema: string): string => {
  let out = sqlText;

  // FK targets: production SQL references public.users; bind to fixture schema.
  out = out.replaceAll('"public"."users"', `"${schema}"."users"`);
  out = out.replaceAll('REFERENCES "public"."users"', `REFERENCES "${schema}"."users"`);

  // Functions created by 0145 — qualify definition + trigger EXECUTE targets.
  for (const fn of [
    'prevent_platform_resource_revision_mutation',
    'prevent_platform_audit_log_mutation',
  ]) {
    out = out.replaceAll(`FUNCTION "${fn}"`, `FUNCTION "${schema}"."${fn}"`);
    out = out.replaceAll(`FUNCTION "${fn}"()`, `FUNCTION "${schema}"."${fn}"()`);
  }

  const tables = [
    'platform_global_credential_uploads',
    'platform_resource_revisions',
    'platform_audit_logs',
    'user_setting_overrides',
    'user_setting_override_revisions',
    'users',
    'topics',
    'messages',
  ];
  for (const table of tables) {
    // Only bare "table" — skip already-qualified "schema"."table".
    out = out.replaceAll(new RegExp(`(?<!\\.)"${table}"`, 'g'), `"${schema}"."${table}"`);
  }

  // Schema-scope the catalog-guarded CHECK DO block (otherwise public.conname matches).
  out = out.replaceAll(
    /SELECT 1 FROM pg_constraint\s+WHERE conname = 'platform_global_credential_uploads_file_hash_id_check'/g,
    `SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'platform_global_credential_uploads_file_hash_id_check'
        AND n.nspname = '${schema}'`,
  );

  return out;
};

const applySql = async (client: { query: (sql: string) => Promise<unknown> }, sqlText: string) => {
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await client.query(trimmed);
  }
};

describe.skipIf(!enabled)('migration 0145 legacy fixture replay (PostgreSQL)', () => {
  it('transforms legacy staged uploads, installs guards, and is idempotent on second apply', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');

    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    const qualifiedSql = qualifyHardeningSql(hardeningSql, SCHEMA);

    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      // Isolate function resolution + unqualified names inside the fixture schema.
      await client.query(`SET search_path TO ${SCHEMA}, public`);

      // ── Pre-0145 / partial legacy fixture ─────────────────────────────────
      await client.query(`
        CREATE TABLE ${SCHEMA}.users (
          id text PRIMARY KEY
        );
        CREATE TABLE ${SCHEMA}.user_setting_overrides (
          user_id text NOT NULL,
          key text NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE TABLE ${SCHEMA}.user_setting_override_revisions (
          user_id text NOT NULL,
          revision integer NOT NULL,
          PRIMARY KEY (user_id, revision)
        );
        CREATE TABLE ${SCHEMA}.platform_resource_revisions (
          id text PRIMARY KEY,
          payload jsonb DEFAULT '{}'::jsonb NOT NULL
        );
        CREATE TABLE ${SCHEMA}.platform_audit_logs (
          id text PRIMARY KEY,
          action text NOT NULL
        );
        CREATE TABLE ${SCHEMA}.topics (
          id text PRIMARY KEY,
          user_id text,
          title text,
          created_at timestamptz DEFAULT now()
        );
        CREATE TABLE ${SCHEMA}.messages (
          id text PRIMARY KEY,
          user_id text,
          topic_id text,
          role text,
          created_at timestamptz DEFAULT now()
        );

        -- Pre-0145 uploads: content-hash PK, nullable owner, no opaque id.
        CREATE TABLE ${SCHEMA}.platform_global_credential_uploads (
          file_hash_id varchar(64) PRIMARY KEY NOT NULL,
          file_name varchar(255) NOT NULL,
          file_type varchar(128) NOT NULL,
          file_size integer NOT NULL,
          fingerprint varchar(64) NOT NULL,
          ref text NOT NULL,
          ciphertext text NOT NULL,
          key_id varchar(256) NOT NULL,
          created_by text,
          expires_at timestamptz NOT NULL,
          created_at timestamptz DEFAULT now() NOT NULL
        );
      `);

      const ownedHash = 'a'.repeat(64);
      const orphanHash = 'b'.repeat(64);
      const blankOwnerHash = 'c'.repeat(64);
      await client.query(
        `
        INSERT INTO ${SCHEMA}.platform_global_credential_uploads
          (file_hash_id, file_name, file_type, file_size, fingerprint, ref, ciphertext, key_id, created_by, expires_at)
        VALUES
          ($1, 'owned.json', 'application/json', 12, $2, 'kms://platform-global-credentials/upload/owned', 'ct-owned', 'key-1', 'admin-owner', now() + interval '1 hour'),
          ($3, 'orphan.json', 'application/json', 8, $4, 'kms://platform-global-credentials/upload/orphan', 'ct-orphan', 'key-1', NULL, now() + interval '1 hour'),
          ($5, 'blank.json', 'application/json', 8, $6, 'kms://platform-global-credentials/upload/blank', 'ct-blank', 'key-1', '   ', now() + interval '1 hour')
        `,
        [ownedHash, 'd'.repeat(64), orphanHash, 'e'.repeat(64), blankOwnerHash, 'f'.repeat(64)],
      );

      await client.query(`
        INSERT INTO ${SCHEMA}.users (id) VALUES ('user-live');
        INSERT INTO ${SCHEMA}.user_setting_overrides (user_id, key) VALUES
          ('user-live', 'theme'),
          ('user-gone', 'theme');
        INSERT INTO ${SCHEMA}.user_setting_override_revisions (user_id, revision) VALUES
          ('user-live', 1),
          ('user-gone', 1);
      `);

      // ── First apply ───────────────────────────────────────────────────────
      await applySql(client, qualifiedSql);

      const uploads = await client.query<{
        created_by: string;
        file_hash_id: string;
        file_name: string;
        id: string;
      }>(`
        SELECT id, file_hash_id, file_name, created_by
        FROM ${SCHEMA}.platform_global_credential_uploads
        ORDER BY file_hash_id
      `);
      expect(uploads.rows).toHaveLength(1);
      expect(uploads.rows[0]).toMatchObject({
        created_by: 'admin-owner',
        file_hash_id: ownedHash,
        file_name: 'owned.json',
      });
      expect(uploads.rows[0]!.id).toMatch(/^pgcu_[a-f0-9]{16}$/);

      // PK is opaque id (schema-scoped via pg_namespace).
      const pk = await client.query<{ column_name: string }>(`
        SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.indisprimary
          AND n.nspname = '${SCHEMA}'
          AND c.relname = 'platform_global_credential_uploads'
        ORDER BY a.attname
      `);
      expect(pk.rows.map((r) => r.column_name)).toEqual(['id']);

      const createdByNullable = await client.query<{ is_nullable: string }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = '${SCHEMA}'
          AND table_name = 'platform_global_credential_uploads'
          AND column_name = 'created_by'
      `);
      expect(createdByNullable.rows[0]?.is_nullable).toBe('NO');

      // Index DEFINITIONS (columns + uniqueness), not name-only presence.
      // Every name in the IN-list below is asserted — no queried-but-unasserted objects.
      const requiredIndexNames = [
        'platform_global_credential_uploads_owner_hash_unique',
        'platform_global_credential_uploads_created_by_idx',
        'topics_user_id_created_at_id_idx',
        'messages_user_id_topic_id_created_at_id_idx',
        'messages_role_created_at_idx',
        'topics_title_trgm_idx',
      ] as const;
      const indexes = await client.query<{
        indexdef: string;
        indexname: string;
      }>(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = '${SCHEMA}'
          AND indexname IN (
            'platform_global_credential_uploads_owner_hash_unique',
            'platform_global_credential_uploads_created_by_idx',
            'topics_user_id_created_at_id_idx',
            'messages_user_id_topic_id_created_at_id_idx',
            'messages_role_created_at_idx',
            'topics_title_trgm_idx'
          )
        ORDER BY indexname
      `);
      const byName = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
      expect(byName.platform_global_credential_uploads_owner_hash_unique).toMatch(/UNIQUE/i);
      expect(byName.platform_global_credential_uploads_owner_hash_unique).toMatch(
        /\(created_by,\s*file_hash_id\)/i,
      );
      expect(byName.platform_global_credential_uploads_created_by_idx).toMatch(/\(created_by\)/i);
      expect(byName.topics_user_id_created_at_id_idx).toMatch(/\(user_id,\s*created_at,\s*id\)/i);
      expect(byName.messages_user_id_topic_id_created_at_id_idx).toMatch(
        /\(user_id,\s*topic_id,\s*created_at,\s*id\)/i,
      );
      expect(byName.messages_role_created_at_idx).toMatch(/\(role,\s*created_at\)/i);

      // Title GIN is extension-gated in 0145: when pg_trgm is available, the schema-local
      // index MUST be GIN (title gin_trgm_ops). A missing or wrong definition must fail.
      const trgmExt = await client.query<{ extname: string }>(`
        SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
      `);
      const trgmAvailable = trgmExt.rows.length > 0;
      if (trgmAvailable) {
        expect(byName.topics_title_trgm_idx).toBeDefined();
        expect(byName.topics_title_trgm_idx).toMatch(/USING\s+gin/i);
        expect(byName.topics_title_trgm_idx).toMatch(/\(\s*title\s+gin_trgm_ops\s*\)/i);
      } else {
        expect(byName.topics_title_trgm_idx).toBeUndefined();
      }
      // Sanity: every non-optional required index was actually returned + asserted above.
      for (const name of requiredIndexNames) {
        if (name === 'topics_title_trgm_idx' && !trgmAvailable) continue;
        expect(byName[name], `missing or unasserted index ${name}`).toBeDefined();
      }

      // CHECK expression is schema-scoped and enforces 64-hex file_hash_id.
      const hashCheck = await client.query<{
        conname: string;
        def: string;
      }>(`
        SELECT c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_class rel ON rel.oid = c.conrelid
        WHERE n.nspname = '${SCHEMA}'
          AND rel.relname = 'platform_global_credential_uploads'
          AND c.conname = 'platform_global_credential_uploads_file_hash_id_check'
      `);
      expect(hashCheck.rows).toHaveLength(1);
      expect(hashCheck.rows[0]!.def).toMatch(/file_hash_id/i);
      expect(hashCheck.rows[0]!.def).toMatch(/\^\[a-f0-9\]\{64\}\$/);

      // Functions live in the isolated schema (not only public).
      const functions = await client.query<{ proname: string }>(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${SCHEMA}'
          AND p.proname IN (
            'prevent_platform_resource_revision_mutation',
            'prevent_platform_audit_log_mutation'
          )
        ORDER BY p.proname
      `);
      expect(functions.rows.map((r) => r.proname)).toEqual([
        'prevent_platform_audit_log_mutation',
        'prevent_platform_resource_revision_mutation',
      ]);

      const triggers = await client.query<{ tgname: string }>(`
        SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = '${SCHEMA}'
          AND t.tgname IN (
            'platform_resource_revisions_immutable',
            'platform_audit_logs_append_only'
          )
        ORDER BY t.tgname
      `);
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        'platform_audit_logs_append_only',
        'platform_resource_revisions_immutable',
      ]);

      await client.query(`INSERT INTO ${SCHEMA}.platform_resource_revisions (id) VALUES ('rev-1')`);
      await expect(
        client.query(
          `UPDATE ${SCHEMA}.platform_resource_revisions SET payload = '{}'::jsonb WHERE id = 'rev-1'`,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        client.query(`DELETE FROM ${SCHEMA}.platform_resource_revisions WHERE id = 'rev-1'`),
      ).rejects.toThrow(/immutable/i);

      await client.query(
        `INSERT INTO ${SCHEMA}.platform_audit_logs (id, action) VALUES ('log-1', 'x')`,
      );
      await expect(
        client.query(`UPDATE ${SCHEMA}.platform_audit_logs SET action = 'y' WHERE id = 'log-1'`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        client.query(`DELETE FROM ${SCHEMA}.platform_audit_logs WHERE id = 'log-1'`),
      ).rejects.toThrow(/append-only/i);
      // Transaction-local GUC escape hatch (same contract as production retention deletes).
      await client.query('BEGIN');
      await client.query(`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
      await client.query(`DELETE FROM ${SCHEMA}.platform_audit_logs WHERE id = 'log-1'`);
      await client.query('COMMIT');

      const overrides = await client.query<{ user_id: string }>(`
        SELECT user_id FROM ${SCHEMA}.user_setting_overrides ORDER BY user_id
      `);
      expect(overrides.rows.map((r) => r.user_id)).toEqual(['user-live']);

      // FK cascade behavior (schema-scoped): confdeltype 'c' = CASCADE.
      const fks = await client.query<{
        conname: string;
        confdeltype: string;
        confupdtype: string;
        def: string;
      }>(`
        SELECT
          c.conname,
          c.confdeltype,
          c.confupdtype,
          pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = '${SCHEMA}'
          AND c.contype = 'f'
          AND c.conname IN (
            'user_setting_overrides_user_id_users_id_fk',
            'user_setting_override_revisions_user_id_users_id_fk'
          )
        ORDER BY c.conname
      `);
      expect(fks.rows).toHaveLength(2);
      for (const fk of fks.rows) {
        expect(fk.confdeltype).toBe('c'); // ON DELETE CASCADE
        expect(fk.def).toMatch(/ON DELETE CASCADE/i);
        expect(fk.def).toMatch(new RegExp(`${SCHEMA}\\.users|users`, 'i'));
      }

      // Live cascade: deleting the user removes the override row in this schema.
      await client.query(`DELETE FROM ${SCHEMA}.users WHERE id = 'user-live'`);
      const overridesAfterCascade = await client.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM ${SCHEMA}.user_setting_overrides
      `);
      expect(overridesAfterCascade.rows[0]?.n).toBe('0');
      const revsAfterCascade = await client.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM ${SCHEMA}.user_setting_override_revisions
      `);
      expect(revsAfterCascade.rows[0]?.n).toBe('0');

      // Re-seed user for second-apply data stability (uploads row still present).
      await client.query(`INSERT INTO ${SCHEMA}.users (id) VALUES ('user-live')`);

      const ownedIdAfterFirst = uploads.rows[0]!.id;
      const uploadCountAfterFirst = uploads.rows.length;

      // ── Second apply (idempotency) ────────────────────────────────────────
      await applySql(client, qualifiedSql);

      const uploadsSecond = await client.query<{ id: string; file_hash_id: string }>(`
        SELECT id, file_hash_id
        FROM ${SCHEMA}.platform_global_credential_uploads
        ORDER BY file_hash_id
      `);
      expect(uploadsSecond.rows).toHaveLength(uploadCountAfterFirst);
      expect(uploadsSecond.rows[0]?.id).toBe(ownedIdAfterFirst);
      expect(uploadsSecond.rows[0]?.file_hash_id).toBe(ownedHash);

      const triggersSecond = await client.query<{ n: string; tgname: string }>(`
        SELECT t.tgname, count(*)::text AS n
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = '${SCHEMA}'
          AND t.tgname IN (
            'platform_resource_revisions_immutable',
            'platform_audit_logs_append_only'
          )
        GROUP BY t.tgname
        ORDER BY t.tgname
      `);
      expect(triggersSecond.rows).toEqual([
        { n: '1', tgname: 'platform_audit_logs_append_only' },
        { n: '1', tgname: 'platform_resource_revisions_immutable' },
      ]);

      // Second apply must not duplicate schema-local functions or FKs.
      const functionsSecond = await client.query<{ n: string; proname: string }>(`
        SELECT p.proname, count(*)::text AS n
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${SCHEMA}'
          AND p.proname IN (
            'prevent_platform_resource_revision_mutation',
            'prevent_platform_audit_log_mutation'
          )
        GROUP BY p.proname
        ORDER BY p.proname
      `);
      expect(functionsSecond.rows).toEqual([
        { n: '1', proname: 'prevent_platform_audit_log_mutation' },
        { n: '1', proname: 'prevent_platform_resource_revision_mutation' },
      ]);

      const fksSecond = await client.query<{ n: string }>(`
        SELECT count(*)::text AS n
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = '${SCHEMA}'
          AND c.contype = 'f'
          AND c.conname IN (
            'user_setting_overrides_user_id_users_id_fk',
            'user_setting_override_revisions_user_id_users_id_fk'
          )
      `);
      expect(fksSecond.rows[0]?.n).toBe('2');

      // Indexes still present with the same definitions after second apply
      // (includes topics_title_trgm_idx when pg_trgm was available on first apply).
      const secondIndexNames = [
        'platform_global_credential_uploads_owner_hash_unique',
        'platform_global_credential_uploads_created_by_idx',
        'topics_user_id_created_at_id_idx',
        'messages_user_id_topic_id_created_at_id_idx',
        'messages_role_created_at_idx',
        ...(trgmAvailable ? (['topics_title_trgm_idx'] as const) : []),
      ];
      const indexesSecond = await client.query<{ indexdef: string; indexname: string }>(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = '${SCHEMA}'
          AND indexname IN (${secondIndexNames.map((n) => `'${n}'`).join(', ')})
        ORDER BY indexname
      `);
      expect(indexesSecond.rows).toHaveLength(secondIndexNames.length);
      for (const row of indexesSecond.rows) {
        expect(row.indexdef).toBe(byName[row.indexname]);
      }
      if (trgmAvailable) {
        const trgmSecond = indexesSecond.rows.find((r) => r.indexname === 'topics_title_trgm_idx');
        expect(trgmSecond?.indexdef).toMatch(/USING\s+gin/i);
        expect(trgmSecond?.indexdef).toMatch(/\(\s*title\s+gin_trgm_ops\s*\)/i);
        expect(trgmSecond?.indexdef).toBe(byName.topics_title_trgm_idx);
      }
    } finally {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } catch {
        // best-effort cleanup
      }
      try {
        await client.query('SET search_path TO public');
      } catch {
        // ignore
      }
      client.release();
      await pool.end();
    }
  }, 60_000);
});
