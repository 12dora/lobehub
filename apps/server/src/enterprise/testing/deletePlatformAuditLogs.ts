import { inArray, type SQL, sql } from 'drizzle-orm';

import { platformAuditLogs } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

export interface DeletePlatformAuditLogsForTestOptions {
  /**
   * Prefer when the suite owns known actor ids — concurrent suites must not wipe each other
   * (SG-07). Empty array is a **no-op** (never a full-table delete). Omit only when the suite
   * intentionally clears the whole table in an exclusive DB.
   */
  actorUserIds?: readonly string[];
  /**
   * Extra filter. Mutually exclusive with `actorUserIds` — combining both is rejected so a
   * future caller cannot accidentally run a wider delete than intended (including empty arrays).
   */
  where?: SQL;
}

/**
 * Test-only delete of `platform_audit_logs` that opts into the append-only trigger escape hatch.
 *
 * Production trigger `prevent_platform_audit_log_mutation` rejects bare DELETE unless the
 * transaction-local GUC `lobe.allow_platform_audit_log_delete=on` is set. GUC is transaction-
 * scoped (`is_local=true`) so it cannot leak past cleanup.
 */
export const deletePlatformAuditLogsForTest = async (
  db: LobeChatDatabase,
  options: DeletePlatformAuditLogsForTestOptions = {},
): Promise<void> => {
  const hasActorsOption = options.actorUserIds !== undefined;
  const hasWhere = options.where !== undefined;

  if (hasActorsOption && hasWhere) {
    throw new Error('deletePlatformAuditLogsForTest: pass either actorUserIds or where, not both');
  }

  // Empty actor list must never widen to a full-table wipe (dynamic fixtures can yield []).
  if (hasActorsOption && options.actorUserIds!.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    if (hasActorsOption) {
      await tx
        .delete(platformAuditLogs)
        .where(inArray(platformAuditLogs.actorUserId, [...options.actorUserIds!]));
      return;
    }
    if (hasWhere) {
      await tx.delete(platformAuditLogs).where(options.where!);
      return;
    }
    await tx.delete(platformAuditLogs);
  });
};
