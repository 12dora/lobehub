import { and, count, eq, inArray, sql } from 'drizzle-orm';

import {
  type NewPlatformSettingPolicy,
  type PlatformRevisionStatus,
  type PlatformSettingMode,
  platformSettingPolicies,
  type PlatformSettingPolicyItem,
  platformSettingsBundle,
  type PlatformSettingsBundleItem,
  type PlatformSettingVisibility,
  type UserSettingOverrideItem,
  type UserSettingOverrideRevisionItem,
  userSettingOverrideRevisions,
  userSettingOverrides,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import type { ResourcePointerAdapter } from './revision';
import {
  overrideRowsJsonAggSql,
  platformRevisionSql,
  publishedPoliciesJsonAggSql,
  readExecuteRows,
  runInSettingsTx,
  userOverrideRevisionSql,
} from './settingsSnapshotSql';

export const PLATFORM_SETTINGS_BUNDLE_ID = 'global';

/** Parse json_agg results that may already be arrays (drivers differ). */
const parseJsonArray = <T>(value: T[] | string | null | undefined): T[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

export type SettingsDraftPolicyMap = Record<
  string,
  {
    mode: PlatformSettingMode;
    schemaVersion: number;
    value?: unknown;
    visibility: PlatformSettingVisibility;
  }
>;

/**
 * Aggregate settings bundle + published path policies + user overrides.
 * Uses `db.select()` builders (no relational query API).
 */
export class PlatformSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  // ── Bundle (aggregate pointer + draft) ─────────────────────

  ensureBundle = async (): Promise<PlatformSettingsBundleItem> => {
    const existing = await this.getBundle();
    if (existing) return existing;

    const [row] = await this.db
      .insert(platformSettingsBundle)
      .values({
        draft: {},
        id: PLATFORM_SETTINGS_BUNDLE_ID,
        revision: 0,
        status: 'draft',
      })
      .onConflictDoNothing()
      .returning();

    if (row) return row;
    const again = await this.getBundle();
    if (!again) throw new Error('Failed to ensure platform_settings_bundle');
    return again;
  };

  getBundle = async (): Promise<PlatformSettingsBundleItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformSettingsBundle)
      .where(eq(platformSettingsBundle.id, PLATFORM_SETTINGS_BUNDLE_ID))
      .limit(1);
    return rows[0];
  };

  /**
   * SELECT … FOR UPDATE on the aggregate settings pointer.
   * Used so user patch/reset and publish cannot interleave policy checks (B3-R2).
   */
  lockBundleForUpdate = async (): Promise<number> => {
    await this.ensureBundle();
    const result = await this.db.execute(
      sql`SELECT "revision" FROM "platform_settings_bundle" WHERE "id" = ${PLATFORM_SETTINGS_BUNDLE_ID} FOR UPDATE`,
    );
    const row = readExecuteRows<{ revision: number }>(result)[0];
    return Number(row?.revision ?? 0);
  };

  saveDraft = async (params: {
    draft: SettingsDraftPolicyMap;
    updatedBy?: string | null;
  }): Promise<PlatformSettingsBundleItem> => {
    await this.ensureBundle();
    const [row] = await this.db
      .update(platformSettingsBundle)
      .set({
        draft: params.draft,
        updatedAt: new Date(),
        updatedBy: params.updatedBy ?? null,
      })
      .where(eq(platformSettingsBundle.id, PLATFORM_SETTINGS_BUNDLE_ID))
      .returning();
    return row;
  };

  /**
   * Replace published path policies to match the draft snapshot for a revision.
   * Called inside the publish transaction after pointer update.
   */
  replacePublishedPolicies = async (params: {
    draft: SettingsDraftPolicyMap;
    revision: number;
    updatedBy?: string | null;
  }): Promise<void> => {
    const paths = Object.keys(params.draft);

    // Delete paths no longer in draft
    if (paths.length === 0) {
      await this.db.delete(platformSettingPolicies);
    } else {
      const existing = await this.db
        .select({ path: platformSettingPolicies.path })
        .from(platformSettingPolicies);
      const keep = new Set(paths);
      const toDelete = existing.map((r) => r.path).filter((p) => !keep.has(p));
      if (toDelete.length > 0) {
        await this.db
          .delete(platformSettingPolicies)
          .where(inArray(platformSettingPolicies.path, toDelete));
      }
    }

    if (paths.length === 0) return;

    const now = new Date();
    const rows: NewPlatformSettingPolicy[] = paths.map((path) => {
      const policy = params.draft[path]!;
      return {
        mode: policy.mode,
        path,
        revision: params.revision,
        schemaVersion: policy.schemaVersion,
        status: 'published' as const,
        updatedAt: now,
        updatedBy: params.updatedBy ?? null,
        value: policy.value,
        visibility: policy.visibility,
      };
    });

    // Single multi-row upsert keeps the publish lock for one round-trip instead of N.
    await this.db
      .insert(platformSettingPolicies)
      .values(rows)
      .onConflictDoUpdate({
        set: {
          mode: sql`excluded.mode`,
          revision: sql`excluded.revision`,
          schemaVersion: sql`excluded.schema_version`,
          status: sql`excluded.status`,
          updatedAt: sql`excluded.updated_at`,
          updatedBy: sql`excluded.updated_by`,
          value: sql`excluded.value`,
          visibility: sql`excluded.visibility`,
        },
        target: platformSettingPolicies.path,
      });
  };

  listPublishedPolicies = async (): Promise<PlatformSettingPolicyItem[]> => {
    return this.db
      .select()
      .from(platformSettingPolicies)
      .where(eq(platformSettingPolicies.status, 'published'));
  };

  /**
   * Platform + user override revision tokens in one round-trip.
   * Prefer this over separate `getBundle` + `getUserOverrideRevision` on the hot path.
   */
  getRevisionTokens = async (
    userId: string | null,
  ): Promise<{ platformRevision: number; userOverrideRevision: number }> => {
    if (!userId) {
      const bundle = await this.getBundle();
      return { platformRevision: bundle?.revision ?? 0, userOverrideRevision: 0 };
    }

    const row = await this.executeOneRow<{
      platform_revision: number | string;
      user_override_revision: number | string;
    }>(sql`
      SELECT
        COALESCE(
          (
            SELECT "revision"
            FROM "platform_settings_bundle"
            WHERE "id" = ${PLATFORM_SETTINGS_BUNDLE_ID}
          ),
          0
        ) AS "platform_revision",
        COALESCE(
          (
            SELECT "revision"
            FROM "user_setting_override_revisions"
            WHERE "user_id" = ${userId}
          ),
          0
        ) AS "user_override_revision"
    `);
    return {
      platformRevision: Number(row?.platform_revision ?? 0),
      userOverrideRevision: Number(row?.user_override_revision ?? 0),
    };
  };

  /**
   * Causally consistent effective-settings snapshot in a single SQL statement.
   *
   * Independent SELECTs under READ COMMITTED can interleave with publish/override
   * commits and pair old tokens with new rows (or vice versa). One statement sees a
   * single snapshot, so tokens + published policies + overrides are always coherent
   * without retry — and without doubling the hot-path query count.
   *
   * Pass `userId: null` for platform-layer-only (no override reads).
   * `seedRevisions` / `maxAttempts` are accepted for API compatibility but unused:
   * a single-statement read cannot exhaust or return a mixed snapshot.
   */
  readEffectiveSettingsSnapshot = async (params: {
    maxAttempts?: number;
    seedRevisions?: { platformRevision: number; userOverrideRevision: number };
    userId: string | null;
  }): Promise<{
    overrideRows: UserSettingOverrideItem[];
    platformRevision: number;
    published: PlatformSettingPolicyItem[];
    userOverrideRevision: number;
  }> => {
    // seedRevisions / maxAttempts intentionally unused — single-statement path.
    void params.seedRevisions;
    void params.maxAttempts;

    if (!params.userId) {
      const row = await this.executeOneRow<{
        platform_revision: number | string;
        published: PlatformSettingPolicyItem[] | string | null;
      }>(sql`
        SELECT
          ${platformRevisionSql(PLATFORM_SETTINGS_BUNDLE_ID)} AS "platform_revision",
          ${publishedPoliciesJsonAggSql()} AS "published"
      `);
      return {
        overrideRows: [],
        platformRevision: Number(row?.platform_revision ?? 0),
        published: parseJsonArray<PlatformSettingPolicyItem>(row?.published),
        userOverrideRevision: 0,
      };
    }

    const row = await this.executeOneRow<{
      override_rows: UserSettingOverrideItem[] | string | null;
      platform_revision: number | string;
      published: PlatformSettingPolicyItem[] | string | null;
      user_override_revision: number | string;
    }>(sql`
      SELECT
        ${platformRevisionSql(PLATFORM_SETTINGS_BUNDLE_ID)} AS "platform_revision",
        ${userOverrideRevisionSql(params.userId)} AS "user_override_revision",
        ${publishedPoliciesJsonAggSql()} AS "published",
        ${overrideRowsJsonAggSql(params.userId)} AS "override_rows"
    `);

    return {
      overrideRows: parseJsonArray<UserSettingOverrideItem>(row?.override_rows),
      platformRevision: Number(row?.platform_revision ?? 0),
      published: parseJsonArray<PlatformSettingPolicyItem>(row?.published),
      userOverrideRevision: Number(row?.user_override_revision ?? 0),
    };
  };

  /** Normalize drizzle/pg/pglite execute() row shapes to a single object. */
  private executeOneRow = async <T extends Record<string, unknown>>(
    query: ReturnType<typeof sql>,
  ): Promise<T | undefined> => {
    const result = await this.db.execute(query);
    return readExecuteRows<T>(result)[0];
  };

  getPublishedPolicy = async (path: string): Promise<PlatformSettingPolicyItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformSettingPolicies)
      .where(
        and(
          eq(platformSettingPolicies.path, path),
          eq(platformSettingPolicies.status, 'published'),
        ),
      )
      .limit(1);
    return rows[0];
  };

  /**
   * Indexed aggregate: count override rows for given paths (impact preview).
   * Does not iterate users.
   */
  countOverridesByPaths = async (
    paths: string[],
  ): Promise<{ pathsWithOverrides: number; totalOverrideRows: number }> => {
    if (paths.length === 0) return { pathsWithOverrides: 0, totalOverrideRows: 0 };

    const rows = await this.db
      .select({
        path: userSettingOverrides.path,
        rowCount: count(),
      })
      .from(userSettingOverrides)
      .where(inArray(userSettingOverrides.path, paths))
      .groupBy(userSettingOverrides.path);

    const totalOverrideRows = rows.reduce((sum, r) => sum + Number(r.rowCount), 0);
    return { pathsWithOverrides: rows.length, totalOverrideRows };
  };

  // ── User overrides ─────────────────────────────────────────

  listUserOverrides = async (userId: string): Promise<UserSettingOverrideItem[]> => {
    return this.db
      .select()
      .from(userSettingOverrides)
      .where(eq(userSettingOverrides.userId, userId));
  };

  getUserOverride = async (
    userId: string,
    path: string,
  ): Promise<UserSettingOverrideItem | undefined> => {
    const rows = await this.db
      .select()
      .from(userSettingOverrides)
      .where(and(eq(userSettingOverrides.userId, userId), eq(userSettingOverrides.path, path)))
      .limit(1);
    return rows[0];
  };

  /**
   * Upsert override + bump user override revision in one transaction
   * (monotonic, survives last-delete).
   */
  upsertUserOverride = async (params: {
    path: string;
    source?: string;
    userId: string;
    value: unknown;
    /** When true, caller already holds a transaction on `this.db`. */
    alreadyInTransaction?: boolean;
  }): Promise<{ override: UserSettingOverrideItem; revision: number }> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const model = new PlatformSettingsModel(db);
      const now = new Date();
      const [override] = await db
        .insert(userSettingOverrides)
        .values({
          path: params.path,
          source: params.source ?? 'user',
          updatedAt: now,
          userId: params.userId,
          value: params.value,
        })
        .onConflictDoUpdate({
          set: {
            source: params.source ?? 'user',
            updatedAt: now,
            value: params.value,
          },
          target: [userSettingOverrides.userId, userSettingOverrides.path],
        })
        .returning();
      const revision = await model.bumpUserOverrideRevision(params.userId);
      return { override, revision };
    };

    return runInSettingsTx(this.db, params.alreadyInTransaction, run);
  };

  /**
   * Delete exactly one path override + bump revision in one transaction.
   */
  deleteUserOverride = async (
    userId: string,
    path: string,
    opts?: { alreadyInTransaction?: boolean },
  ): Promise<{ deleted: boolean; revision: number }> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const model = new PlatformSettingsModel(db);
      const deleted = await db
        .delete(userSettingOverrides)
        .where(and(eq(userSettingOverrides.userId, userId), eq(userSettingOverrides.path, path)))
        .returning({ path: userSettingOverrides.path });
      const revision = await model.bumpUserOverrideRevision(userId);
      return { deleted: deleted.length > 0, revision };
    };

    return runInSettingsTx(this.db, opts?.alreadyInTransaction, run);
  };

  /**
   * Multi-path upsert + single revision bump inside one transaction.
   */
  upsertUserOverridesBatch = async (params: {
    afterOverrideWrite?: (index: number) => Promise<void>;
    ops: Array<{ path: string; value: unknown }>;
    source?: string;
    userId: string;
    alreadyInTransaction?: boolean;
    beforeRevisionBump?: () => Promise<void>;
  }): Promise<number> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const model = new PlatformSettingsModel(db);
      const now = new Date();
      for (const [index, op] of params.ops.entries()) {
        await db
          .insert(userSettingOverrides)
          .values({
            path: op.path,
            source: params.source ?? 'user',
            updatedAt: now,
            userId: params.userId,
            value: op.value,
          })
          .onConflictDoUpdate({
            set: {
              source: params.source ?? 'user',
              updatedAt: now,
              value: op.value,
            },
            target: [userSettingOverrides.userId, userSettingOverrides.path],
          });
        await params.afterOverrideWrite?.(index);
      }
      await params.beforeRevisionBump?.();
      return model.bumpUserOverrideRevision(params.userId);
    };

    return runInSettingsTx(this.db, params.alreadyInTransaction, run);
  };

  /**
   * Insert override rows only when absent (idempotent migration / backfill).
   * Never overwrites an existing override. Bumps the user revision only when
   * at least one row was inserted.
   */
  insertUserOverridesIfAbsent = async (params: {
    alreadyInTransaction?: boolean;
    ops: Array<{ path: string; value: unknown }>;
    source?: string;
    userId: string;
  }): Promise<{ insertedPaths: string[]; revision: number }> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const model = new PlatformSettingsModel(db);
      if (params.ops.length === 0) {
        return {
          insertedPaths: [] as string[],
          revision: await model.getUserOverrideRevision(params.userId),
        };
      }
      const now = new Date();
      const insertedPaths: string[] = [];
      for (const op of params.ops) {
        const rows = await db
          .insert(userSettingOverrides)
          .values({
            path: op.path,
            source: params.source ?? 'user',
            updatedAt: now,
            userId: params.userId,
            value: op.value,
          })
          .onConflictDoNothing({
            target: [userSettingOverrides.userId, userSettingOverrides.path],
          })
          .returning({ path: userSettingOverrides.path });
        if (rows[0]?.path) insertedPaths.push(rows[0].path);
      }
      if (insertedPaths.length === 0) {
        return { insertedPaths, revision: await model.getUserOverrideRevision(params.userId) };
      }
      return {
        insertedPaths,
        revision: await model.bumpUserOverrideRevision(params.userId),
      };
    };

    return runInSettingsTx(this.db, params.alreadyInTransaction, run);
  };

  /** Delete all overrides for a user + bump revision once (full reset). */
  deleteAllUserOverrides = async (
    userId: string,
    opts?: { alreadyInTransaction?: boolean },
  ): Promise<number> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const model = new PlatformSettingsModel(db);
      await db.delete(userSettingOverrides).where(eq(userSettingOverrides.userId, userId));
      return model.bumpUserOverrideRevision(userId);
    };
    return runInSettingsTx(this.db, opts?.alreadyInTransaction, run);
  };

  getUserOverrideRevision = async (userId: string): Promise<number> => {
    const rows = await this.db
      .select()
      .from(userSettingOverrideRevisions)
      .where(eq(userSettingOverrideRevisions.userId, userId))
      .limit(1);
    return rows[0]?.revision ?? 0;
  };

  bumpUserOverrideRevision = async (userId: string): Promise<number> => {
    const now = new Date();
    const [row] = await this.db
      .insert(userSettingOverrideRevisions)
      .values({ revision: 1, updatedAt: now, userId })
      .onConflictDoUpdate({
        set: {
          revision: sql`${userSettingOverrideRevisions.revision} + 1`,
          updatedAt: now,
        },
        target: userSettingOverrideRevisions.userId,
      })
      .returning();
    return row.revision;
  };
}

export type CreateSettingsPointerAdapterOptions = {
  assertLockedState?: ResourcePointerAdapter['assertLockedState'];
  bundleId?: string;
  /**
   * Materialize published policies (+ optional draft align) inside the publish/rollback txn.
   * Receives the same tx as pointer update.
   */
  materializePublished?: ResourcePointerAdapter['materializePublished'];
  prepareLockedPublish?: ResourcePointerAdapter['prepareLockedPublish'];
  updatedBy?: string | null;
};

/**
 * FOR UPDATE pointer adapter for aggregate settings bundle.
 * Pass `materializePublished` so path policies commit atomically with the revision head.
 */
export const createSettingsPointerAdapter = (
  options: CreateSettingsPointerAdapterOptions | string = {},
): ResourcePointerAdapter => {
  const opts: CreateSettingsPointerAdapterOptions =
    typeof options === 'string' ? { bundleId: options } : options;
  const bundleId = opts.bundleId ?? PLATFORM_SETTINGS_BUNDLE_ID;

  return {
    assertLockedState: opts.assertLockedState,
    lockAndGetRevision: async (tx) => {
      const result = await tx.execute(
        sql`SELECT "revision" FROM "platform_settings_bundle" WHERE "id" = ${bundleId} FOR UPDATE`,
      );
      const row = readExecuteRows<{ revision: number }>(result)[0];
      if (!row) {
        throw new Error(`Settings bundle not found: ${bundleId}`);
      }
      return Number(row.revision);
    },
    materializePublished: opts.materializePublished,
    prepareLockedPublish: opts.prepareLockedPublish,
    updatePointer: async (tx, { revision, status }) => {
      await tx
        .update(platformSettingsBundle)
        .set({
          revision,
          status: status as Extract<PlatformRevisionStatus, 'draft' | 'published' | 'archived'>,
          updatedAt: new Date(),
        })
        .where(eq(platformSettingsBundle.id, bundleId));
    },
  };
};

export type {
  PlatformSettingsBundleItem,
  UserSettingOverrideItem,
  UserSettingOverrideRevisionItem,
};
