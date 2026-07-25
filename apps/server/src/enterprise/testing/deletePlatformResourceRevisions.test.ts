// @vitest-environment node
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { deletePlatformResourceRevisionsForTest } from './deletePlatformResourceRevisions';

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

describe('deletePlatformResourceRevisionsForTest filter contract', () => {
  it('deletes by non-empty resourceIds without starting a full-table delete', async () => {
    const { db, deleteFn, deleteWhere, transaction } = makeDb();
    await deletePlatformResourceRevisionsForTest(db, {
      resourceIds: ['global'],
      resourceType: 'settings',
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('no-ops on empty resourceIds without starting a transaction or full-table delete', async () => {
    const { db, deleteFn, transaction } = makeDb();
    await deletePlatformResourceRevisionsForTest(db, { resourceIds: [] });
    expect(transaction).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('accepts a where-only delete', async () => {
    const { db, deleteFn, deleteWhere, transaction } = makeDb();
    await deletePlatformResourceRevisionsForTest(db, { where: sql`true` });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('throws when resourceIds and where are both supplied (including empty resourceIds)', async () => {
    const { db, transaction } = makeDb();
    await expect(
      deletePlatformResourceRevisionsForTest(db, {
        resourceIds: ['global'],
        where: sql`true`,
      }),
    ).rejects.toThrow(/either resourceIds or where/);
    await expect(
      deletePlatformResourceRevisionsForTest(db, { resourceIds: [], where: sql`true` }),
    ).rejects.toThrow(/either resourceIds or where/);
    expect(transaction).not.toHaveBeenCalled();
  });
});
