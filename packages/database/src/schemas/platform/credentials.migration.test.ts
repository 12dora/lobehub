// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrations = path.join(import.meta.dirname, '../../../migrations');
const foundationName = '0138_w10_platform_global_credentials';
const hardeningName = '0145_platform_db_hardening';
const foundationSql = readFileSync(path.join(migrations, `${foundationName}.sql`), 'utf8');
const hardeningSql = readFileSync(path.join(migrations, `${hardeningName}.sql`), 'utf8');
const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const previousSnapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0144_snapshot.json'), 'utf8'),
) as {
  id: string;
  tables: Record<
    string,
    {
      columns?: Record<string, { notNull?: boolean; primaryKey?: boolean }>;
      foreignKeys?: Record<string, unknown>;
      indexes?: Record<string, unknown>;
    }
  >;
};
const snapshot = JSON.parse(
  readFileSync(path.join(migrations, 'meta/0145_snapshot.json'), 'utf8'),
) as {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns?: Record<string, { notNull?: boolean; primaryKey?: boolean }>;
      foreignKeys?: Record<string, unknown>;
      indexes?: Record<string, unknown>;
    }
  >;
};

const applySql = async (db: PGlite, sqlText: string) => {
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    if (statement.trim()) await db.exec(statement);
  }
};

describe('platform global credential migrations', () => {
  it('makes the foundation migration safely replayable', () => {
    expect(foundationSql).toContain('CREATE TABLE IF NOT EXISTS "platform_global_credentials"');
    expect(foundationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_global_credential_secrets"',
    );
    expect(foundationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "platform_global_credential_uploads"',
    );
    expect(foundationSql).toContain(
      'DROP CONSTRAINT IF EXISTS "platform_global_credential_secrets_credential_id_platform_global_credentials_id_fk"',
    );
    expect(foundationSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "platform_global_credentials_key_unique"',
    );
    expect(foundationSql).toContain(
      'CREATE INDEX IF NOT EXISTS "platform_global_credential_uploads_expires_at_idx"',
    );
    // Catalog-guarded CHECK repair for partial schemas.
    expect(foundationSql).toContain("conname = 'platform_global_credentials_type_check'");
    expect(foundationSql).toContain("conname = 'platform_global_credential_uploads_ref_check'");
    expect(foundationSql).toContain(
      "conname = 'platform_global_credential_secrets_revision_check'",
    );
    // No unguarded bare CREATE TABLE / CREATE INDEX left.
    expect(foundationSql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(foundationSql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  });

  it('hardens staged uploads for owner binding and opaque ids', () => {
    expect(hardeningSql).toContain('platform_global_credential_uploads_owner_hash_unique');
    expect(hardeningSql).toContain('ALTER COLUMN "created_by" SET NOT NULL');
    expect(hardeningSql).toContain('ADD PRIMARY KEY ("id")');
    expect(hardeningSql).toContain('platform_resource_revisions_immutable');
    expect(hardeningSql).toContain('platform_audit_logs_append_only');
    expect(hardeningSql).toContain('lobe.allow_platform_audit_log_delete');
    expect(hardeningSql).toContain('user_setting_overrides_user_id_users_id_fk');
    expect(hardeningSql).toContain('user_setting_override_revisions_user_id_users_id_fk');
    expect(hardeningSql).toContain('topics_user_id_created_at_id_idx');
    expect(hardeningSql).toContain('messages_user_id_topic_id_created_at_id_idx');
    expect(hardeningSql).toContain('messages_role_created_at_idx');
    expect(hardeningSql).toContain('topics_title_trgm_idx');
  });

  it('keeps journal entries for foundation and hardening migrations', () => {
    expect(journal.entries.find(({ tag }) => tag === foundationName)).toMatchObject({
      tag: foundationName,
    });
    expect(journal.entries.find(({ tag }) => tag === hardeningName)).toMatchObject({
      tag: hardeningName,
    });
    expect(
      readdirSync(path.join(migrations, 'meta')).filter((file) => file.endsWith('_snapshot.json')),
    ).toEqual(expect.arrayContaining(['0145_snapshot.json']));
  });

  it('aligns 0145 snapshot with credential ownership and settings FKs', () => {
    expect(snapshot.prevId).toBe(previousSnapshot.id);

    const uploads = snapshot.tables['public.platform_global_credential_uploads'];
    expect(uploads?.columns?.id?.primaryKey).toBe(true);
    expect(uploads?.columns?.file_hash_id?.primaryKey).toBe(false);
    expect(uploads?.columns?.created_by?.notNull).toBe(true);
    expect(uploads?.indexes).toHaveProperty('platform_global_credential_uploads_owner_hash_unique');

    expect(snapshot.tables['public.user_setting_overrides']?.foreignKeys).toHaveProperty(
      'user_setting_overrides_user_id_users_id_fk',
    );
    expect(snapshot.tables['public.user_setting_override_revisions']?.foreignKeys).toHaveProperty(
      'user_setting_override_revisions_user_id_users_id_fk',
    );

    expect(snapshot.tables['public.topics']?.indexes).toHaveProperty(
      'topics_user_id_created_at_id_idx',
    );
    expect(snapshot.tables['public.messages']?.indexes).toHaveProperty(
      'messages_user_id_topic_id_created_at_id_idx',
    );
    expect(snapshot.tables['public.messages']?.indexes).toHaveProperty(
      'messages_role_created_at_idx',
    );
  });

  it('replays foundation migration twice from an empty database', async () => {
    const db = new PGlite();
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        await applySql(db, foundationSql);
      }
      const tables = await db.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'platform_global_credential%'
        ORDER BY table_name
      `);
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        'platform_global_credential_secrets',
        'platform_global_credential_uploads',
        'platform_global_credentials',
      ]);

      const checks = await db.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE conname LIKE 'platform_global_credential%'
        ORDER BY conname
      `);
      expect(checks.rows.map((r) => r.conname)).toEqual(
        expect.arrayContaining([
          'platform_global_credential_secrets_fingerprint_check',
          'platform_global_credential_secrets_ref_check',
          'platform_global_credential_secrets_revision_check',
          'platform_global_credential_uploads_file_size_check',
          'platform_global_credential_uploads_fingerprint_check',
          'platform_global_credential_uploads_ref_check',
          'platform_global_credentials_key_check',
          'platform_global_credentials_type_check',
        ]),
      );
    } finally {
      await db.close();
    }
  });

  it('repairs CHECK constraints on a partially provisioned uploads table', async () => {
    const db = new PGlite();
    try {
      // Partial schema: table without CHECKs (simulates interrupted first apply).
      await db.exec(`
        CREATE TABLE "platform_global_credential_uploads" (
          "file_hash_id" varchar(64) PRIMARY KEY NOT NULL,
          "file_name" varchar(255) NOT NULL,
          "file_type" varchar(128) NOT NULL,
          "file_size" integer NOT NULL,
          "fingerprint" varchar(64) NOT NULL,
          "ref" text NOT NULL,
          "ciphertext" text NOT NULL,
          "key_id" varchar(256) NOT NULL,
          "created_by" text,
          "expires_at" timestamp with time zone NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "platform_global_credentials" (
          "id" serial PRIMARY KEY NOT NULL,
          "key" varchar(100) NOT NULL,
          "name" varchar(255) NOT NULL,
          "type" varchar(32) NOT NULL,
          "meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
          "enabled" boolean DEFAULT true NOT NULL,
          "created_by" text,
          "updated_by" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "platform_global_credential_secrets" (
          "id" text PRIMARY KEY NOT NULL,
          "credential_id" integer NOT NULL,
          "fingerprint" varchar(64) NOT NULL,
          "ref" text NOT NULL,
          "ciphertext" text NOT NULL,
          "key_id" varchar(256) NOT NULL,
          "revision" integer DEFAULT 1 NOT NULL,
          "revoked_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await applySql(db, foundationSql);

      const checks = await db.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE conname IN (
          'platform_global_credential_uploads_ref_check',
          'platform_global_credentials_type_check',
          'platform_global_credential_secrets_revision_check'
        )
        ORDER BY conname
      `);
      expect(checks.rows.map((r) => r.conname).sort()).toEqual([
        'platform_global_credential_secrets_revision_check',
        'platform_global_credential_uploads_ref_check',
        'platform_global_credentials_type_check',
      ]);
    } finally {
      await db.close();
    }
  });
});
