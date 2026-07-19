// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '../../type';
import {
  acquireIdentityProviderPublishedRevisionLock,
  withIdentityProviderPublishedRevisionLock,
} from './identityProviderPublishedRevisionLock';

describe('identity provider published-revision lock', () => {
  it('acquires the transaction-scoped advisory lock before running canonical work', async () => {
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push('lock');
      return { rows: [] };
    });
    const tx = { execute } as unknown as Transaction;
    const db = {
      transaction: async (work: (transaction: Transaction) => Promise<string>) => {
        order.push('transaction');
        return work(tx);
      },
    } as unknown as LobeChatDatabase;

    await expect(
      withIdentityProviderPublishedRevisionLock(db, async (transaction) => {
        expect(transaction).toBe(tx);
        order.push('work');
        return 'done';
      }),
    ).resolves.toBe('done');

    expect(order).toEqual(['transaction', 'lock', 'work']);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('can acquire the shared lock inside an existing writer transaction', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await acquireIdentityProviderPublishedRevisionLock({ execute } as unknown as Transaction);

    expect(execute).toHaveBeenCalledOnce();
  });
});
