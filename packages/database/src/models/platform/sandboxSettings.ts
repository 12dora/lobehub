import { and, eq } from 'drizzle-orm';

import {
  DEFAULT_PLATFORM_SANDBOX_SETTINGS,
  normalizeSandboxSettings,
  type PlatformSandboxSettings,
} from '@/types/platform/sandboxSettings';

import { platformSandboxSettings } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

/** Singleton row identity — there is exactly one platform sandbox-settings document. */
export const PLATFORM_SANDBOX_SETTINGS_ID = 'global';

/** Sandbox settings projection including the CAS revision token. */
export type PlatformSandboxSettingsWithRevision = PlatformSandboxSettings & { revision: number };

/**
 * Reads and writes the singleton {@link platformSandboxSettings} row.
 * Absent row → built-in defaults (`enabled: false`, revision 0).
 *
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class PlatformSandboxSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformSandboxSettingsWithRevision> => {
    const [row] = await this.db
      .select()
      .from(platformSandboxSettings)
      .where(eq(platformSandboxSettings.id, PLATFORM_SANDBOX_SETTINGS_ID))
      .limit(1);

    if (!row) {
      return { ...DEFAULT_PLATFORM_SANDBOX_SETTINGS, revision: 0 };
    }

    return { ...normalizeSandboxSettings(row.config), revision: row.revision };
  };

  /**
   * Replace the persisted config with CAS. Every successful write bumps `revision`.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   */
  update = async (
    actorId: string | null,
    patch: PlatformSandboxSettings & { expectedRevision: number },
  ): Promise<PlatformSandboxSettingsWithRevision> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select()
        .from(platformSandboxSettings)
        .where(eq(platformSandboxSettings.id, PLATFORM_SANDBOX_SETTINGS_ID))
        .limit(1)
        .for('update');

      const currentRevision = locked?.revision ?? 0;
      if (currentRevision !== patch.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Sandbox settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_SANDBOX_SETTINGS_ID,
            resourceType: 'sandbox_settings',
          },
        );
      }

      const { expectedRevision: _expectedRevision, ...configInput } = patch;
      const next = normalizeSandboxSettings(configInput);
      const nextRevision = currentRevision + 1;

      if (!locked) {
        const [inserted] = await db
          .insert(platformSandboxSettings)
          .values({
            config: next,
            id: PLATFORM_SANDBOX_SETTINGS_ID,
            revision: nextRevision,
            updatedBy: actorId,
          })
          .onConflictDoNothing({ target: platformSandboxSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Sandbox settings revision conflict: concurrent first-write',
            {
              expectedRevision: patch.expectedRevision,
              resourceId: PLATFORM_SANDBOX_SETTINGS_ID,
              resourceType: 'sandbox_settings',
            },
          );
        }
        return { ...next, revision: nextRevision };
      }

      const [updated] = await db
        .update(platformSandboxSettings)
        .set({
          config: next,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(platformSandboxSettings.id, PLATFORM_SANDBOX_SETTINGS_ID),
            eq(platformSandboxSettings.revision, patch.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Sandbox settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_SANDBOX_SETTINGS_ID,
            resourceType: 'sandbox_settings',
          },
        );
      }

      return { ...next, revision: nextRevision };
    };

    // Callers that need atomicity (router + audit) pass a Transaction; do not nest.
    return run(this.db);
  };
}
