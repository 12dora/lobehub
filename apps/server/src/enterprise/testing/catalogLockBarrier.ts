import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { expect } from 'vitest';

import type { PlatformTemplateCatalogDomain } from '@/database/models/platform';
import { platformTemplateCatalogLockKey } from '@/database/models/platform';
import * as schema from '@/database/schemas';
import type { LobeChatDatabase, Transaction } from '@/database/type';

const ADVISORY_LOCK_WAIT_MS = 8_000;
const ADVISORY_LOCK_POLL_MS = 15;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const connectionString = () => {
  const url = process.env.DATABASE_TEST_URL?.trim();
  if (!url) throw new Error('DATABASE_TEST_URL is required for catalog lock barrier tests');
  return url;
};

const waitForCatalogLockWaiter = async (observer: Pool, domain: PlatformTemplateCatalogDomain) => {
  const key = platformTemplateCatalogLockKey(domain);
  const deadline = Date.now() + ADVISORY_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    // Single-key pg_advisory_xact_lock(bigint): classid/objid are the two halves of hashtext(key).
    const locks = await observer.query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND objsubid = 1
          AND classid = (((hashtext($1)::bigint) >> 32) & 4294967295)::oid
          AND objid = ((hashtext($1)::bigint) & 4294967295)::oid
        LIMIT 1`,
      [key],
    );
    if ((locks.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, ADVISORY_LOCK_POLL_MS));
  }
  throw new Error(`timed out waiting for a blocked waiter on ${key} (${ADVISORY_LOCK_WAIT_MS}ms)`);
};

/**
 * Run `work` on an independent connection inside an open transaction (the catalog
 * lock is acquired by the model method `work` calls — create / import / seed / delete),
 * then start `competing` and require it to block on that xact lock before the holder
 * commits. Exact serialized outcomes belong to the caller after this resolves.
 */
export const holdCatalogTxAndAssertBlocked = async (params: {
  competing: () => Promise<unknown>;
  domain: PlatformTemplateCatalogDomain;
  work: (tx: Transaction) => Promise<void>;
}): Promise<void> => {
  const url = connectionString();
  const holderPool = new Pool({ connectionString: url, max: 1 });
  const observerPool = new Pool({ connectionString: url, max: 1 });
  const holderDb = drizzle(holderPool, { schema }) as unknown as LobeChatDatabase;
  const release = deferred();
  const locked = deferred<{ error?: unknown }>();

  const holder = holderDb
    .transaction(async (tx) => {
      await params.work(tx as unknown as Transaction);
      locked.resolve({});
      await release.promise;
    })
    .catch((error: unknown) => {
      locked.resolve({ error });
      throw error;
    });

  const lockedState = await locked.promise;
  if (lockedState.error) {
    await observerPool.end();
    await holderPool.end();
    throw lockedState.error;
  }

  let settled = false;
  const competing = params.competing().finally(() => {
    settled = true;
  });

  try {
    await waitForCatalogLockWaiter(observerPool, params.domain);
    expect(settled).toBe(false);
  } catch (error) {
    release.resolve();
    await Promise.allSettled([holder, competing]);
    await observerPool.end();
    await holderPool.end();
    throw error;
  }

  release.resolve();
  await holder;
  await competing;
  await observerPool.end();
  await holderPool.end();
};
