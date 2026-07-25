// @vitest-environment node
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { deletePlatformAuditLogsForTest } from './deletePlatformAuditLogs';

const makeDb = () => {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));
  const execute = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({ delete: deleteFn, execute });
  });
  return {
    db: { transaction } as unknown as LobeChatDatabase,
    deleteFn,
    deleteWhere,
    execute,
    transaction,
  };
};

describe('deletePlatformAuditLogsForTest filter contract', () => {
  it('deletes by non-empty actorUserIds without opening a combined filter', async () => {
    const { db, deleteFn, deleteWhere, transaction } = makeDb();
    await deletePlatformAuditLogsForTest(db, { actorUserIds: ['admin-1'] });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('no-ops on empty actorUserIds without starting a transaction or full-table delete', async () => {
    const { db, deleteFn, transaction } = makeDb();
    await deletePlatformAuditLogsForTest(db, { actorUserIds: [] });
    expect(transaction).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('accepts a where-only delete', async () => {
    const { db, deleteFn, deleteWhere, transaction } = makeDb();
    await deletePlatformAuditLogsForTest(db, { where: sql`true` });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('throws when actorUserIds and where are both supplied (including empty actors)', async () => {
    const { db, transaction } = makeDb();
    await expect(
      deletePlatformAuditLogsForTest(db, { actorUserIds: ['admin-1'], where: sql`true` }),
    ).rejects.toThrow(/either actorUserIds or where/);
    await expect(
      deletePlatformAuditLogsForTest(db, { actorUserIds: [], where: sql`true` }),
    ).rejects.toThrow(/either actorUserIds or where/);
    expect(transaction).not.toHaveBeenCalled();
  });
});
