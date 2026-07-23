/**
 * Shared transaction-level advisory lock serializing legal-hold mutations
 * with destructive retention deletes.
 */
import { sql } from 'drizzle-orm';

import type { LobeChatDatabase, Transaction } from '../../type';

/** Stable 2-int pair for pg_advisory_xact_lock (namespace + resource). */
export const PLATFORM_AUDIT_RETENTION_HOLD_LOCK_NAMESPACE = 1_784_145_201;
export const PLATFORM_AUDIT_RETENTION_HOLD_LOCK_RESOURCE = 1_784_145_202;

type DatabaseExecutor = LobeChatDatabase | Transaction;

export const acquirePlatformAuditRetentionHoldLock = async (
  db: DatabaseExecutor,
): Promise<void> => {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(${PLATFORM_AUDIT_RETENTION_HOLD_LOCK_NAMESPACE}, ${PLATFORM_AUDIT_RETENTION_HOLD_LOCK_RESOURCE})`,
  );
};

export const withPlatformAuditRetentionHoldLock = async <T>(
  db: LobeChatDatabase,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  db.transaction(async (tx) => {
    await acquirePlatformAuditRetentionHoldLock(tx);
    return work(tx);
  });
