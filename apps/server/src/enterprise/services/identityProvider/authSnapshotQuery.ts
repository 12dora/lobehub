import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';

import type { PlatformIdentityProviderInstanceItem } from '@/database/schemas/platform';
import {
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { IDENTITY_PROVIDER_INSTANCE_STALE_MS } from './instanceRegistry';
import {
  IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT,
  IdentityProviderSystemError,
} from './systemService';

export interface AuthSnapshotPendingRow {
  activationRevision: number | null;
  id: string;
  providerKey: string;
}

export interface AuthSnapshotRestartRequestRow {
  requestId: string;
  resultCategory: string | null;
  status: 'accepted' | 'failed' | 'prepared' | 'signaled';
}

export interface AuthSnapshotRows {
  cutoff: Date;
  freshInstances: PlatformIdentityProviderInstanceItem[];
  localRow: PlatformIdentityProviderInstanceItem | undefined;
  pendingRows: AuthSnapshotPendingRow[];
  staleAggregate: { count: number } | undefined;
  staleInstances: PlatformIdentityProviderInstanceItem[];
}

export const queryAuthSnapshotRows = async (
  tx: Transaction,
  localInstanceId: string,
): Promise<AuthSnapshotRows> => {
  const snapshotClock = await tx.execute<{ cutoff: Date | string }>(
    sql`SELECT clock_timestamp() - (${IDENTITY_PROVIDER_INSTANCE_STALE_MS} * interval '1 millisecond') AS cutoff`,
  );
  const rawCutoff = snapshotClock.rows[0]?.cutoff;
  const cutoff = rawCutoff instanceof Date ? rawCutoff : new Date(rawCutoff ?? Number.NaN);
  if (Number.isNaN(cutoff.getTime())) {
    throw new IdentityProviderSystemError('PLATFORM_IDENTITY_RESTART_STATUS_UNAVAILABLE');
  }
  const freshInstances = await tx
    .select()
    .from(platformIdentityProviderInstances)
    .where(
      and(
        gte(platformIdentityProviderInstances.lastHeartbeat, cutoff),
        ne(platformIdentityProviderInstances.instanceId, localInstanceId),
      ),
    )
    .orderBy(
      desc(platformIdentityProviderInstances.lastHeartbeat),
      asc(platformIdentityProviderInstances.instanceId),
    );
  const [localRow] = await tx
    .select()
    .from(platformIdentityProviderInstances)
    .where(eq(platformIdentityProviderInstances.instanceId, localInstanceId))
    .limit(1);
  const [staleAggregate] = await tx
    .select({ count: count() })
    .from(platformIdentityProviderInstances)
    .where(
      and(
        lt(platformIdentityProviderInstances.lastHeartbeat, cutoff),
        ne(platformIdentityProviderInstances.instanceId, localInstanceId),
      ),
    );
  const staleInstances = await tx
    .select()
    .from(platformIdentityProviderInstances)
    .where(
      and(
        lt(platformIdentityProviderInstances.lastHeartbeat, cutoff),
        ne(platformIdentityProviderInstances.instanceId, localInstanceId),
      ),
    )
    .orderBy(
      desc(platformIdentityProviderInstances.lastHeartbeat),
      asc(platformIdentityProviderInstances.instanceId),
    )
    .limit(IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT);
  const pendingRows = await tx
    .select({
      activationRevision: platformIdentityProviders.activationRevision,
      id: platformIdentityProviders.id,
      providerKey: platformIdentityProviders.providerKey,
    })
    .from(platformIdentityProviders)
    .where(eq(platformIdentityProviders.status, 'pending_restart'));

  return {
    cutoff,
    freshInstances,
    localRow,
    pendingRows,
    staleAggregate,
    staleInstances,
  };
};

export const queryRecentRestartRequests = async (
  tx: Transaction,
  localInstanceId: string,
): Promise<AuthSnapshotRestartRequestRow[]> => {
  return tx
    .select({
      requestId: platformIdentityProviderRestartRequests.requestId,
      resultCategory: platformIdentityProviderRestartRequests.resultCategory,
      status: platformIdentityProviderRestartRequests.status,
    })
    .from(platformIdentityProviderRestartRequests)
    .where(
      and(
        eq(platformIdentityProviderRestartRequests.targetInstanceId, localInstanceId),
        inArray(platformIdentityProviderRestartRequests.status, ['accepted', 'signaled', 'failed']),
      ),
    )
    .orderBy(desc(platformIdentityProviderRestartRequests.createdAt))
    .limit(32);
};
