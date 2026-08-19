import type { SQL } from 'drizzle-orm';
import { and, asc, inArray } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { LobeChatDatabase, Transaction } from '../../type';

export const boundedSkipLockedDelete = async (params: {
  db: LobeChatDatabase | Transaction;
  idColumn: AnyPgColumn;
  limit: number;
  orderColumn: AnyPgColumn;
  table: PgTable;
  where: SQL | undefined;
}) =>
  params.db
    .delete(params.table)
    .where(
      and(
        inArray(
          params.idColumn,
          params.db
            .select({ id: params.idColumn })
            .from(params.table)
            .where(params.where)
            .orderBy(asc(params.orderColumn))
            .limit(params.limit)
            .for('update', { skipLocked: true }),
        ),
        params.where,
      ),
    )
    .returning({ id: params.idColumn });
