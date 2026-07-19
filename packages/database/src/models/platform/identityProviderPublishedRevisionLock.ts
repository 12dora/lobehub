import { sql } from 'drizzle-orm';

import type { LobeChatDatabase, Transaction } from '../../type';

export const IDENTITY_PROVIDER_PUBLISHED_REVISION_LOCK_NAMESPACE = 1_278_874_436;
export const IDENTITY_PROVIDER_PUBLISHED_REVISION_LOCK_RESOURCE = 1_223_953_479;

type DatabaseExecutor = LobeChatDatabase | Transaction;

/** Serializes OIDC published-head reads/writes without covering remote validation. */
export const acquireIdentityProviderPublishedRevisionLock = async (
  db: DatabaseExecutor,
): Promise<void> => {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(${IDENTITY_PROVIDER_PUBLISHED_REVISION_LOCK_NAMESPACE}, ${IDENTITY_PROVIDER_PUBLISHED_REVISION_LOCK_RESOURCE})`,
  );
};

export const withIdentityProviderPublishedRevisionLock = async <T>(
  db: LobeChatDatabase,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  db.transaction(async (tx) => {
    await acquireIdentityProviderPublishedRevisionLock(tx);
    return work(tx);
  });
