import { and, eq } from 'drizzle-orm';

import { inTransaction } from '../../repositories/platform/tx';
import {
  PLATFORM_MODULE_SETTINGS_ID,
  platformModuleSettings,
  type PlatformModuleSettingsMap,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

export { PLATFORM_MODULE_SETTINGS_ID };

export interface PlatformModuleSettingsRow {
  createdAt: Date;
  id: typeof PLATFORM_MODULE_SETTINGS_ID;
  modules: PlatformModuleSettingsMap;
  revision: number;
  setupCompletedAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface UpsertModuleSettingsCasInput {
  expectedRevision: number;
  modules: PlatformModuleSettingsMap;
  setupCompletedAt?: Date | null;
  updatedBy: string | null;
}

/**
 * Reads and writes the singleton {@link platformModuleSettings} row.
 *
 * Absent row → `get()` returns `null` (callers treat that as "all modules on").
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class PlatformModuleSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformModuleSettingsRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformModuleSettings)
      .where(eq(platformModuleSettings.id, PLATFORM_MODULE_SETTINGS_ID))
      .limit(1);

    return row ? this.toRow(row) : null;
  };

  /**
   * Replace persisted modules (and optionally setupCompletedAt) with CAS.
   * Every successful write bumps `revision`. First write (no row) requires
   * `expectedRevision === 0` and inserts at revision 1.
   *
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  upsertWithCas = async (
    params: UpsertModuleSettingsCasInput,
  ): Promise<PlatformModuleSettingsRow> => {
    const run = async (db: Transaction) => {
      const [locked] = await db
        .select()
        .from(platformModuleSettings)
        .where(eq(platformModuleSettings.id, PLATFORM_MODULE_SETTINGS_ID))
        .limit(1)
        .for('update');

      const currentRevision = locked?.revision ?? 0;
      if (currentRevision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Module settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: PLATFORM_MODULE_SETTINGS_ID,
            resourceType: 'module_settings',
          },
        );
      }

      const nextRevision = currentRevision + 1;
      const modules = params.modules;
      const setupCompletedAt =
        params.setupCompletedAt === undefined
          ? (locked?.setupCompletedAt ?? null)
          : params.setupCompletedAt;

      if (!locked) {
        const [inserted] = await db
          .insert(platformModuleSettings)
          .values({
            id: PLATFORM_MODULE_SETTINGS_ID,
            modules,
            revision: nextRevision,
            setupCompletedAt,
            updatedBy: params.updatedBy,
          })
          .onConflictDoNothing({ target: platformModuleSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Module settings revision conflict: concurrent first-write',
            {
              expectedRevision: params.expectedRevision,
              resourceId: PLATFORM_MODULE_SETTINGS_ID,
              resourceType: 'module_settings',
            },
          );
        }
        return this.toRow(inserted);
      }

      const [updated] = await db
        .update(platformModuleSettings)
        .set({
          modules,
          revision: nextRevision,
          setupCompletedAt,
          updatedAt: new Date(),
          updatedBy: params.updatedBy,
        })
        .where(
          and(
            eq(platformModuleSettings.id, PLATFORM_MODULE_SETTINGS_ID),
            eq(platformModuleSettings.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Module settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: PLATFORM_MODULE_SETTINGS_ID,
            resourceType: 'module_settings',
          },
        );
      }

      return this.toRow(updated);
    };

    return inTransaction(this.db, run);
  };

  private toRow = (row: typeof platformModuleSettings.$inferSelect): PlatformModuleSettingsRow => ({
    createdAt: row.createdAt,
    id: PLATFORM_MODULE_SETTINGS_ID,
    modules: row.modules ?? {},
    revision: row.revision,
    setupCompletedAt: row.setupCompletedAt ?? null,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  });
}
