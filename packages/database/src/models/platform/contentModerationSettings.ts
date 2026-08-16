import { and, eq } from 'drizzle-orm';

import type { ContentModerationConfig } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import {
  PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
  platformContentModerationSettings,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

export { PLATFORM_CONTENT_MODERATION_SETTINGS_ID };

export interface PlatformContentModerationSettingsRow {
  config: ContentModerationConfig;
  createdAt: Date;
  id: string;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Reads and writes the singleton {@link platformContentModerationSettings} row.
 *
 * Deep-import this file from the chat / runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class PlatformContentModerationSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformContentModerationSettingsRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformContentModerationSettings)
      .where(eq(platformContentModerationSettings.id, PLATFORM_CONTENT_MODERATION_SETTINGS_ID))
      .limit(1);

    return row ? this.toRow(row) : null;
  };

  ensureDefault = async (): Promise<PlatformContentModerationSettingsRow> => {
    const existing = await this.get();
    if (existing) return existing;

    const config = createDefaultContentModerationConfig();
    const [inserted] = await this.db
      .insert(platformContentModerationSettings)
      .values({
        config,
        id: PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
        revision: 0,
      })
      .onConflictDoNothing({ target: platformContentModerationSettings.id })
      .returning();

    if (inserted) return this.toRow(inserted);

    const raced = await this.get();
    if (!raced) throw new Error('Failed to ensure default content-moderation settings');
    return raced;
  };

  /**
   * Replace the persisted config with CAS.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  update = async (params: {
    config: ContentModerationConfig;
    expectedRevision: number;
    updatedBy: string | null;
  }): Promise<PlatformContentModerationSettingsRow> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select()
        .from(platformContentModerationSettings)
        .where(eq(platformContentModerationSettings.id, PLATFORM_CONTENT_MODERATION_SETTINGS_ID))
        .limit(1)
        .for('update');

      const currentRevision = locked?.revision ?? 0;
      if (currentRevision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Content moderation settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
            resourceType: 'content_moderation_settings',
          },
        );
      }

      const nextRevision = currentRevision + 1;

      if (!locked) {
        const [inserted] = await db
          .insert(platformContentModerationSettings)
          .values({
            config: params.config,
            id: PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
            revision: nextRevision,
            updatedBy: params.updatedBy,
          })
          .onConflictDoNothing({ target: platformContentModerationSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Content moderation settings revision conflict: concurrent first-write',
            {
              expectedRevision: params.expectedRevision,
              resourceId: PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
              resourceType: 'content_moderation_settings',
            },
          );
        }
        return this.toRow(inserted);
      }

      const [updated] = await db
        .update(platformContentModerationSettings)
        .set({
          config: params.config,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: params.updatedBy,
        })
        .where(
          and(
            eq(platformContentModerationSettings.id, PLATFORM_CONTENT_MODERATION_SETTINGS_ID),
            eq(platformContentModerationSettings.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Content moderation settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: params.expectedRevision,
            resourceId: PLATFORM_CONTENT_MODERATION_SETTINGS_ID,
            resourceType: 'content_moderation_settings',
          },
        );
      }

      return this.toRow(updated);
    };

    return run(this.db);
  };

  private toRow = (
    row: typeof platformContentModerationSettings.$inferSelect,
  ): PlatformContentModerationSettingsRow => ({
    config: row.config,
    createdAt: row.createdAt,
    id: row.id,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  });
}
