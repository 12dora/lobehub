import { and, eq } from 'drizzle-orm';

import type { InfraSettingsId } from '@/const/platform/infraSettings';
import { INFRA_SETTINGS_IDS } from '@/const/platform/infraSettings';
import type { InfraSettingsPersistedConfig } from '@/types/platform/infraSettings';
import { createDefaultInfraConfig, normalizeInfraConfig } from '@/types/platform/infraSettings';

import { inTransaction } from '../../repositories/platform/tx';
import {
  INFRA_SETTINGS_MAIL_ID,
  INFRA_SETTINGS_OBJECT_STORAGE_ID,
  platformInfraSettings,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

export { INFRA_SETTINGS_MAIL_ID, INFRA_SETTINGS_OBJECT_STORAGE_ID };

const isInfraSettingsId = (id: string): id is InfraSettingsId =>
  (INFRA_SETTINGS_IDS as readonly string[]).includes(id);

export interface PlatformInfraSettingsRow {
  config: InfraSettingsPersistedConfig;
  createdAt: Date;
  id: InfraSettingsId;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Reads and writes a {@link platformInfraSettings} row keyed by
 * `'object_storage'` or `'mail'`.
 *
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class InfraSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (id: InfraSettingsId): Promise<PlatformInfraSettingsRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformInfraSettings)
      .where(eq(platformInfraSettings.id, id))
      .limit(1);

    return row ? this.toRow(row) : null;
  };

  ensureDefault = async (id: InfraSettingsId): Promise<PlatformInfraSettingsRow> => {
    const existing = await this.get(id);
    if (existing) return existing;

    const [inserted] = await this.db
      .insert(platformInfraSettings)
      .values({
        config: createDefaultInfraConfig(id),
        id,
        revision: 0,
      })
      .onConflictDoNothing({ target: platformInfraSettings.id })
      .returning();

    if (inserted) return this.toRow(inserted);

    const raced = await this.get(id);
    if (!raced) throw new Error(`Failed to ensure default infra settings for ${id}`);
    return raced;
  };

  /**
   * Replace the persisted config with CAS. Every successful write bumps `revision`.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  update = async (params: {
    config: InfraSettingsPersistedConfig;
    expectedRevision: number;
    id: InfraSettingsId;
    updatedBy: string | null;
  }): Promise<PlatformInfraSettingsRow> => {
    const run = async (db: Transaction) => {
      const [locked] = await db
        .select()
        .from(platformInfraSettings)
        .where(eq(platformInfraSettings.id, params.id))
        .limit(1)
        .for('update');

      const currentRevision = locked?.revision ?? 0;
      if (currentRevision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Infra settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: params.id,
            resourceType: 'infra_settings',
          },
        );
      }

      const nextRevision = currentRevision + 1;
      const config = normalizeInfraConfig(params.id, params.config);

      if (!locked) {
        const [inserted] = await db
          .insert(platformInfraSettings)
          .values({
            config,
            id: params.id,
            revision: nextRevision,
            updatedBy: params.updatedBy,
          })
          .onConflictDoNothing({ target: platformInfraSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Infra settings revision conflict: concurrent first-write',
            {
              expectedRevision: params.expectedRevision,
              resourceId: params.id,
              resourceType: 'infra_settings',
            },
          );
        }
        return this.toRow(inserted);
      }

      const [updated] = await db
        .update(platformInfraSettings)
        .set({
          config,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: params.updatedBy,
        })
        .where(
          and(
            eq(platformInfraSettings.id, params.id),
            eq(platformInfraSettings.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Infra settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: params.id,
            resourceType: 'infra_settings',
          },
        );
      }

      return this.toRow(updated);
    };

    return inTransaction(this.db, run);
  };

  private toRow = (row: typeof platformInfraSettings.$inferSelect): PlatformInfraSettingsRow => {
    if (!isInfraSettingsId(row.id)) {
      throw new Error(`Unexpected platform_infra_settings id: ${row.id}`);
    }
    return {
      config: normalizeInfraConfig(row.id, row.config),
      createdAt: row.createdAt,
      id: row.id,
      revision: row.revision,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? null,
    };
  };
}
