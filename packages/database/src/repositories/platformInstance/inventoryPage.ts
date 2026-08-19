import { and, eq, gt, gte, lt, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type {
  PlatformIdentityProviderInstanceItem,
  PlatformInstanceHeartbeatItem,
} from '../../schemas/platform';

export const freshnessPredicate = (
  column: AnyPgColumn,
  freshness: 'all' | 'live' | 'offline',
  cutoff: Date,
) =>
  freshness === 'live'
    ? gte(column, cutoff)
    : freshness === 'offline'
      ? lt(column, cutoff)
      : undefined;

export const heartbeatIdCursor = (
  heartbeatCol: AnyPgColumn,
  idCol: AnyPgColumn,
  cursor?: { instanceId: string; lastHeartbeatAt: Date },
) =>
  cursor
    ? or(
        lt(heartbeatCol, cursor.lastHeartbeatAt),
        and(eq(heartbeatCol, cursor.lastHeartbeatAt), gt(idCol, cursor.instanceId)),
      )
    : undefined;

export const mergeInventoryCandidates = (
  platformRows: PlatformInstanceHeartbeatItem[],
  identityRows: PlatformIdentityProviderInstanceItem[],
  limit: number,
) =>
  [
    ...platformRows.map((instance) => ({
      heartbeat: instance.lastHeartbeatAt,
      instance,
      instanceId: instance.instanceId,
      instanceKind: 'platform' as const,
    })),
    ...identityRows.map((instance) => ({
      heartbeat: instance.lastHeartbeat,
      instance,
      instanceId: instance.instanceId,
      instanceKind: 'identity_startup' as const,
    })),
  ]
    .sort(
      (left, right) =>
        right.heartbeat.getTime() - left.heartbeat.getTime() ||
        left.instanceId.localeCompare(right.instanceId),
    )
    .slice(0, limit + 1);
