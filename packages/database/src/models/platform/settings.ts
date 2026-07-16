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

export const PLATFORM_SETTINGS_BUNDLE_ID = 'global';

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

    for (const path of paths) {
      const policy = params.draft[path]!;
      const values: NewPlatformSettingPolicy = {
        mode: policy.mode,
        path,
        revision: params.revision,
        schemaVersion: policy.schemaVersion,
        status: 'published',
        updatedAt: new Date(),
        updatedBy: params.updatedBy ?? null,
        value: policy.value,
        visibility: policy.visibility,
      };
      await this.db
        .insert(platformSettingPolicies)
        .values(values)
        .onConflictDoUpdate({
          set: {
            mode: values.mode,
            revision: values.revision,
            schemaVersion: values.schemaVersion,
            status: values.status,
            updatedAt: values.updatedAt,
            updatedBy: values.updatedBy,
            value: values.value,
            visibility: values.visibility,
          },
          target: platformSettingPolicies.path,
        });
    }
  };

  listPublishedPolicies = async (): Promise<PlatformSettingPolicyItem[]> => {
    return this.db
      .select()
      .from(platformSettingPolicies)
      .where(eq(platformSettingPolicies.status, 'published'));
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
   * Upsert override + bump user override revision (monotonic, survives last-delete).
   */
  upsertUserOverride = async (params: {
    path: string;
    source?: string;
    userId: string;
    value: unknown;
  }): Promise<{ override: UserSettingOverrideItem; revision: number }> => {
    const now = new Date();
    const [override] = await this.db
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

    const revision = await this.bumpUserOverrideRevision(params.userId);
    return { override, revision };
  };

  /**
   * Delete exactly one path override for the user; bump revision even if last row.
   * Returns whether a row was deleted.
   */
  deleteUserOverride = async (
    userId: string,
    path: string,
  ): Promise<{ deleted: boolean; revision: number }> => {
    const deleted = await this.db
      .delete(userSettingOverrides)
      .where(and(eq(userSettingOverrides.userId, userId), eq(userSettingOverrides.path, path)))
      .returning({ path: userSettingOverrides.path });

    const revision = await this.bumpUserOverrideRevision(userId);
    return { deleted: deleted.length > 0, revision };
  };

  /**
   * Atomic multi-path upsert for legacy adapter (all-or-nothing caller transaction).
   */
  upsertUserOverridesBatch = async (params: {
    ops: Array<{ path: string; value: unknown }>;
    source?: string;
    userId: string;
  }): Promise<number> => {
    const now = new Date();
    for (const op of params.ops) {
      await this.db
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
    }
    return this.bumpUserOverrideRevision(params.userId);
  };

  getUserOverrideRevision = async (userId: string): Promise<number> => {
    const rows = await this.db
      .select()
      .from(userSettingOverrideRevisions)
      .where(eq(userSettingOverrideRevisions.userId, userId))
      .limit(1);
    return rows[0]?.revision ?? 0;
  };

  private bumpUserOverrideRevision = async (userId: string): Promise<number> => {
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

/**
 * FOR UPDATE pointer adapter for aggregate settings bundle.
 */
export const createSettingsPointerAdapter = (
  bundleId: string = PLATFORM_SETTINGS_BUNDLE_ID,
): ResourcePointerAdapter => ({
  lockAndGetRevision: async (tx) => {
    const result = await tx.execute(
      sql`SELECT "revision" FROM "platform_settings_bundle" WHERE "id" = ${bundleId} FOR UPDATE`,
    );
    const rows =
      (result as unknown as { rows?: { revision: number }[] }).rows ??
      (result as unknown as { revision: number }[]);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      throw new Error(`Settings bundle not found: ${bundleId}`);
    }
    return Number(row.revision);
  },
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
});

export type {
  PlatformSettingsBundleItem,
  UserSettingOverrideItem,
  UserSettingOverrideRevisionItem,
};
