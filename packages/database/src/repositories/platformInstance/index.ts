import { asc, desc, eq, gte, sql } from 'drizzle-orm';

import {
  type PlatformInstanceDomain,
  type PlatformInstanceHeartbeatItem,
  platformInstanceHeartbeats,
  type PlatformInstanceLoadMode,
  type PlatformInstanceRevisionErrorCategory,
  type PlatformInstanceRevisionHealth,
  type PlatformInstanceRevisionSource,
  type PlatformInstanceRevisionStateItem,
  platformInstanceRevisionStates,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export const PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const PLATFORM_INSTANCE_STALE_AFTER_MS = 90_000;

export interface UpsertPlatformInstanceRevisionStateInput {
  domain: PlatformInstanceDomain;
  errorCategory?: PlatformInstanceRevisionErrorCategory | null;
  health: PlatformInstanceRevisionHealth;
  instanceId: string;
  loadedRevision?: number | null;
  loadedRevisionId?: string | null;
  loadMode: PlatformInstanceLoadMode;
  source: PlatformInstanceRevisionSource;
}

/**
 * Persistence boundary for anonymous process inventory and normalized revision/load state.
 * All recency timestamps are authored by PostgreSQL so caller clock skew cannot affect health.
 */
export class PlatformInstanceRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  listFreshInstances = async (): Promise<PlatformInstanceHeartbeatItem[]> => {
    return this.db
      .select()
      .from(platformInstanceHeartbeats)
      .where(
        gte(
          platformInstanceHeartbeats.lastHeartbeatAt,
          sql`clock_timestamp() - ${PLATFORM_INSTANCE_STALE_AFTER_MS} * interval '1 millisecond'`,
        ),
      )
      .orderBy(desc(platformInstanceHeartbeats.lastHeartbeatAt));
  };

  listRevisionStates = async (
    instanceId?: string,
  ): Promise<PlatformInstanceRevisionStateItem[]> => {
    const query = this.db.select().from(platformInstanceRevisionStates);
    return instanceId
      ? query
          .where(eq(platformInstanceRevisionStates.instanceId, instanceId))
          .orderBy(asc(platformInstanceRevisionStates.domain))
      : query.orderBy(
          asc(platformInstanceRevisionStates.instanceId),
          asc(platformInstanceRevisionStates.domain),
        );
  };

  registerInstance = async (instanceId: string): Promise<PlatformInstanceHeartbeatItem> => {
    const [row] = await this.db
      .insert(platformInstanceHeartbeats)
      .values({ instanceId })
      .onConflictDoUpdate({
        set: { instanceId },
        target: platformInstanceHeartbeats.instanceId,
      })
      .returning();
    return row;
  };

  upsertHeartbeat = async (instanceId: string): Promise<PlatformInstanceHeartbeatItem> => {
    const [row] = await this.db
      .insert(platformInstanceHeartbeats)
      .values({ instanceId })
      .onConflictDoUpdate({
        set: { lastHeartbeatAt: sql`clock_timestamp()` },
        target: platformInstanceHeartbeats.instanceId,
      })
      .returning();
    return row;
  };

  upsertRevisionState = async (
    input: UpsertPlatformInstanceRevisionStateInput,
  ): Promise<PlatformInstanceRevisionStateItem> => {
    const values = {
      domain: input.domain,
      errorCategory: input.errorCategory ?? null,
      health: input.health,
      instanceId: input.instanceId,
      loadedRevision: input.loadedRevision ?? null,
      loadedRevisionId: input.loadedRevisionId ?? null,
      loadMode: input.loadMode,
      source: input.source,
    };
    const [row] = await this.db
      .insert(platformInstanceRevisionStates)
      .values(values)
      .onConflictDoUpdate({
        set: {
          errorCategory: values.errorCategory,
          health: values.health,
          loadedAt: sql`clock_timestamp()`,
          loadedRevision: values.loadedRevision,
          loadedRevisionId: values.loadedRevisionId,
          loadMode: values.loadMode,
          source: values.source,
        },
        target: [platformInstanceRevisionStates.instanceId, platformInstanceRevisionStates.domain],
      })
      .returning();
    return row;
  };
}
