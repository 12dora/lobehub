import { and, eq } from 'drizzle-orm';

import {
  DEFAULT_PLATFORM_AUTH_SETTINGS,
  normalizeEmailDomainAllowlist,
  type PlatformAuthSettings,
} from '@/types/platform/authSettings';

import { platformAuthSettings } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

/** Singleton row identity — there is exactly one platform auth-settings document. */
export const PLATFORM_AUTH_SETTINGS_ID = 'global';

/** Auth settings projection including the CAS revision token. */
export type PlatformAuthSettingsWithRevision = PlatformAuthSettings & { revision: number };

/**
 * Reads and writes the singleton {@link platformAuthSettings} row.
 * Absent row → built-in defaults (open registration, no domain restriction, revision 0).
 */
export class PlatformAuthSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformAuthSettingsWithRevision> => {
    const [row] = await this.db
      .select()
      .from(platformAuthSettings)
      .where(eq(platformAuthSettings.id, PLATFORM_AUTH_SETTINGS_ID))
      .limit(1);

    if (!row) {
      return { ...DEFAULT_PLATFORM_AUTH_SETTINGS, revision: 0 };
    }

    return {
      emailDomainAllowlist: normalizeEmailDomainAllowlist(row.emailDomainAllowlist ?? []),
      emailDomainAllowlistEnabled: row.emailDomainAllowlistEnabled,
      openRegistration: row.openRegistration,
      revision: row.revision,
    };
  };

  /**
   * Merge a partial patch onto the current settings and persist with CAS.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   * @throws Error when emailDomainAllowlistEnabled=true with an empty list
   */
  update = async (
    actorId: string | null,
    patch: Partial<PlatformAuthSettings> & { expectedRevision: number },
  ): Promise<PlatformAuthSettingsWithRevision> => {
    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select()
        .from(platformAuthSettings)
        .where(eq(platformAuthSettings.id, PLATFORM_AUTH_SETTINGS_ID))
        .limit(1)
        .for('update');

      const current: PlatformAuthSettingsWithRevision = locked
        ? {
            emailDomainAllowlist: normalizeEmailDomainAllowlist(locked.emailDomainAllowlist ?? []),
            emailDomainAllowlistEnabled: locked.emailDomainAllowlistEnabled,
            openRegistration: locked.openRegistration,
            revision: locked.revision,
          }
        : { ...DEFAULT_PLATFORM_AUTH_SETTINGS, revision: 0 };

      if (current.revision !== patch.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Auth settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: current.revision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_AUTH_SETTINGS_ID,
            resourceType: 'auth_settings',
          },
        );
      }

      const next: PlatformAuthSettings = {
        emailDomainAllowlist: normalizeEmailDomainAllowlist(
          patch.emailDomainAllowlist ?? current.emailDomainAllowlist,
        ),
        emailDomainAllowlistEnabled:
          patch.emailDomainAllowlistEnabled ?? current.emailDomainAllowlistEnabled,
        openRegistration: patch.openRegistration ?? current.openRegistration,
      };

      if (next.emailDomainAllowlistEnabled && next.emailDomainAllowlist.length === 0) {
        throw new Error('PLATFORM_AUTH_SETTINGS_ALLOWLIST_EMPTY');
      }

      const nextRevision = current.revision + 1;

      if (!locked) {
        const [inserted] = await db
          .insert(platformAuthSettings)
          .values({
            id: PLATFORM_AUTH_SETTINGS_ID,
            ...next,
            revision: nextRevision,
            updatedBy: actorId,
          })
          .onConflictDoNothing({ target: platformAuthSettings.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Auth settings revision conflict: concurrent first-write',
            {
              expectedRevision: patch.expectedRevision,
              resourceId: PLATFORM_AUTH_SETTINGS_ID,
              resourceType: 'auth_settings',
            },
          );
        }
        return { ...next, revision: nextRevision };
      }

      const [updated] = await db
        .update(platformAuthSettings)
        .set({
          emailDomainAllowlist: next.emailDomainAllowlist,
          emailDomainAllowlistEnabled: next.emailDomainAllowlistEnabled,
          openRegistration: next.openRegistration,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(platformAuthSettings.id, PLATFORM_AUTH_SETTINGS_ID),
            eq(platformAuthSettings.revision, patch.expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Auth settings revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: current.revision,
            expectedRevision: patch.expectedRevision,
            resourceId: PLATFORM_AUTH_SETTINGS_ID,
            resourceType: 'auth_settings',
          },
        );
      }

      return { ...next, revision: nextRevision };
    };

    // Callers that need atomicity (router + audit) pass a Transaction; do not nest.
    return run(this.db);
  };
}
