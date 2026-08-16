import { and, eq } from 'drizzle-orm';

import { users } from '@/database/schemas';
import { platformAiProviders, platformContentModerationRecords } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export interface RecordUserDisplay {
  avatar: string | null;
  email: string | null;
  fullName: string | null;
  username: string | null;
}

/** True when any published managed provider lets the browser fetch the model API. */
export const hasPublishedClientFetchBypass = async (db: LobeChatDatabase): Promise<boolean> => {
  const [row] = await db
    .select({ id: platformAiProviders.id })
    .from(platformAiProviders)
    .where(
      and(
        eq(platformAiProviders.status, 'published'),
        eq(platformAiProviders.enabled, true),
        eq(platformAiProviders.fetchOnClient, true),
      ),
    )
    .limit(1);
  return Boolean(row);
};

/**
 * Lock the record, mark it revealed, and return the stored full prompt.
 * Returns null when the row is gone (concurrent delete) so the caller can
 * reject without writing an audit row.
 */
export const revealRecordPromptAtomic = async (
  db: LobeChatDatabase | Transaction,
  params: { actorUserId: string; id: string },
): Promise<{ prompt: string | null } | null> => {
  const [row] = await db
    .update(platformContentModerationRecords)
    .set({
      revealedAt: new Date(),
      revealedBy: params.actorUserId,
    })
    .where(eq(platformContentModerationRecords.id, params.id))
    .returning({
      promptFull: platformContentModerationRecords.promptFull,
    });
  if (!row) return null;
  return { prompt: row.promptFull ?? null };
};

export const loadRecordUser = async (
  db: LobeChatDatabase | Transaction,
  userId: string | null,
): Promise<RecordUserDisplay | null> => {
  if (!userId) return null;
  const [row] = await db
    .select({
      avatar: users.avatar,
      email: users.email,
      fullName: users.fullName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
};
