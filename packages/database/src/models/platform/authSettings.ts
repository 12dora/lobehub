import { eq } from 'drizzle-orm';

import {
  DEFAULT_PLATFORM_AUTH_SETTINGS,
  normalizeEmailDomainAllowlist,
  type PlatformAuthSettings,
} from '@/types/platform/authSettings';

import { platformAuthSettings } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

/** Singleton row identity — there is exactly one platform auth-settings document. */
export const PLATFORM_AUTH_SETTINGS_ID = 'global';

/**
 * Reads and writes the singleton {@link platformAuthSettings} row.
 * Absent row → built-in defaults (open registration, no domain restriction).
 */
export class PlatformAuthSettingsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformAuthSettings> => {
    const [row] = await this.db
      .select()
      .from(platformAuthSettings)
      .where(eq(platformAuthSettings.id, PLATFORM_AUTH_SETTINGS_ID))
      .limit(1);

    if (!row) return { ...DEFAULT_PLATFORM_AUTH_SETTINGS };

    return {
      emailDomainAllowlist: normalizeEmailDomainAllowlist(row.emailDomainAllowlist ?? []),
      emailDomainAllowlistEnabled: row.emailDomainAllowlistEnabled,
      openRegistration: row.openRegistration,
    };
  };

  /** Merge a partial patch onto the current settings and persist the singleton row. */
  update = async (
    actorId: string | null,
    patch: Partial<PlatformAuthSettings>,
  ): Promise<PlatformAuthSettings> => {
    const current = await this.get();
    const next: PlatformAuthSettings = {
      emailDomainAllowlist: normalizeEmailDomainAllowlist(
        patch.emailDomainAllowlist ?? current.emailDomainAllowlist,
      ),
      emailDomainAllowlistEnabled:
        patch.emailDomainAllowlistEnabled ?? current.emailDomainAllowlistEnabled,
      openRegistration: patch.openRegistration ?? current.openRegistration,
    };

    await this.db
      .insert(platformAuthSettings)
      .values({
        id: PLATFORM_AUTH_SETTINGS_ID,
        ...next,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        set: {
          emailDomainAllowlist: next.emailDomainAllowlist,
          emailDomainAllowlistEnabled: next.emailDomainAllowlistEnabled,
          openRegistration: next.openRegistration,
          updatedAt: new Date(),
          updatedBy: actorId,
        },
        target: platformAuthSettings.id,
      });

    return next;
  };
}
