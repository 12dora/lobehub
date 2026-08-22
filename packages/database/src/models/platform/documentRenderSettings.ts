import { and, eq } from 'drizzle-orm';

import type { PlatformDocumentRenderSettings } from '@/types/platform/documentRenderSettings';
import {
  DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS,
  normalizeDocumentRenderSettings,
} from '@/types/platform/documentRenderSettings';

import { platformDocumentRenderSettings } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

/** Singleton row identity — there is exactly one platform document-render settings document. */
export const PLATFORM_DOCUMENT_RENDER_SETTINGS_ID = 'global';

/** Document-render settings projection including the CAS revision token. */
export type PlatformDocumentRenderSettingsWithRevision = PlatformDocumentRenderSettings & {
  revision: number;
};

/**
 * Reads and writes the singleton {@link platformDocumentRenderSettings} row.
 * Absent row → built-in defaults (`enabled: false`, revision 0).
 *
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class PlatformDocumentRenderSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformDocumentRenderSettingsWithRevision> => {
    const [row] = await this.db
      .select()
      .from(platformDocumentRenderSettings)
      .where(eq(platformDocumentRenderSettings.id, PLATFORM_DOCUMENT_RENDER_SETTINGS_ID))
      .limit(1);

    if (!row) {
      return { ...DEFAULT_PLATFORM_DOCUMENT_RENDER_SETTINGS, revision: 0 };
    }

    return { ...normalizeDocumentRenderSettings(row.config), revision: row.revision };
  };

  /**
   * Replace the persisted config with CAS. Every successful write bumps `revision`.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  update = async (
    actorId: string | null,
    patch: PlatformDocumentRenderSettings & { expectedRevision: number },
  ): Promise<PlatformDocumentRenderSettingsWithRevision> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select()
        .from(platformDocumentRenderSettings)
        .where(eq(platformDocumentRenderSettings.id, PLATFORM_DOCUMENT_RENDER_SETTINGS_ID))
        .limit(1)
        .for('update');

      const currentRevision = locked?.revision ?? 0;
      if (currentRevision !== patch.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Document-render settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_DOCUMENT_RENDER_SETTINGS_ID,
            resourceType: 'document_render_settings',
          },
        );
      }

      const { expectedRevision: _expectedRevision, ...configInput } = patch;
      const next = normalizeDocumentRenderSettings(configInput);
      const nextRevision = currentRevision + 1;

      if (!locked) {
        const [inserted] = await db
          .insert(platformDocumentRenderSettings)
          .values({
            config: next,
            id: PLATFORM_DOCUMENT_RENDER_SETTINGS_ID,
            revision: nextRevision,
            updatedBy: actorId,
          })
          .onConflictDoNothing({ target: platformDocumentRenderSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Document-render settings revision conflict: concurrent first-write',
            {
              expectedRevision: patch.expectedRevision,
              resourceId: PLATFORM_DOCUMENT_RENDER_SETTINGS_ID,
              resourceType: 'document_render_settings',
            },
          );
        }
        return { ...next, revision: nextRevision };
      }

      const [updated] = await db
        .update(platformDocumentRenderSettings)
        .set({
          config: next,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(platformDocumentRenderSettings.id, PLATFORM_DOCUMENT_RENDER_SETTINGS_ID),
            eq(platformDocumentRenderSettings.revision, patch.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Document-render settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_DOCUMENT_RENDER_SETTINGS_ID,
            resourceType: 'document_render_settings',
          },
        );
      }

      return { ...next, revision: nextRevision };
    };

    // Callers that need atomicity (router + audit) pass a Transaction; do not nest.
    return run(this.db);
  };
}
