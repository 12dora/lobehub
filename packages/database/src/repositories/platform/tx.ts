import type { LobeChatDatabase, Transaction } from '../../type';

export const isRootDatabase = (db: LobeChatDatabase | Transaction): db is LobeChatDatabase =>
  'transaction' in db;

/**
 * Run `operation` inside a transaction when `db` is a root connection.
 * When already inside a transaction, run it on the same handle (no nesting).
 */
export const inTransaction = async <T>(
  db: LobeChatDatabase | Transaction,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> => (isRootDatabase(db) ? db.transaction(operation) : operation(db));
