import { eq, gte } from 'drizzle-orm';

import type { ArtifactState, NetworkProxyEngineState } from '@/types/platform/networkProxy';

import {
  platformInstanceHeartbeats,
  platformNetworkProxyInstanceStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface NetworkProxyInstanceStatusUpsertRow {
  activeNode: string | null;
  aliveNodeCount: number | null;
  appliedEngineGeneration: number | null;
  appliedRevision: number | null;
  arch: string;
  artifacts: ArtifactState[];
  engineState: NetworkProxyEngineState;
  engineVersion: string | null;
  fallbackCount: number;
  instanceId: string;
  lastError: string | null;
  platform: string;
  proxiedCount: number;
}

export interface NetworkProxyInstanceStatusFreshRow {
  activeNode: string | null;
  aliveNodeCount: number | null;
  appliedEngineGeneration: number | null;
  appliedRevision: number | null;
  arch: string;
  artifacts: ArtifactState[];
  engineState: NetworkProxyEngineState;
  engineVersion: string | null;
  fallbackCount: number;
  instanceId: string;
  lastError: string | null;
  lastHeartbeatAt: Date;
  platform: string;
  proxiedCount: number;
  updatedAt: Date;
}

const isForeignKeyViolation = (error: unknown): boolean => {
  const candidates: unknown[] = [error];
  if (error && typeof error === 'object') {
    const e = error as { cause?: unknown; originalError?: unknown };
    if (e.cause) candidates.push(e.cause);
    if (e.originalError) candidates.push(e.originalError);
    if (e.cause && typeof e.cause === 'object' && 'cause' in e.cause) {
      candidates.push((e.cause as { cause?: unknown }).cause);
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const code = 'code' in candidate ? String((candidate as { code?: unknown }).code) : '';
    // Postgres foreign_key_violation
    if (code === '23503') return true;
    const message =
      candidate instanceof Error
        ? candidate.message
        : 'message' in candidate
          ? String((candidate as { message?: unknown }).message)
          : '';
    if (/foreign key|violates foreign key/i.test(message)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key|violates foreign key|23503/i.test(message);
};

/**
 * Per-instance engine status. `upsert` returns false (and does not throw) when
 * the heartbeat row is missing — typical of a lone dev process that has not
 * registered yet.
 *
 * Deep-import this file from the runtime hot path — do not pull `models/platform`.
 */
export class NetworkProxyInstanceStatusModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  upsert = async (row: NetworkProxyInstanceStatusUpsertRow): Promise<boolean> => {
    try {
      await this.db
        .insert(platformNetworkProxyInstanceStatus)
        .values({
          activeNode: row.activeNode,
          aliveNodeCount: row.aliveNodeCount,
          appliedEngineGeneration: row.appliedEngineGeneration,
          appliedRevision: row.appliedRevision,
          arch: row.arch,
          artifactState: row.artifacts,
          engineState: row.engineState,
          engineVersion: row.engineVersion,
          fallbackCount: row.fallbackCount,
          instanceId: row.instanceId,
          lastError: row.lastError,
          platform: row.platform,
          proxiedCount: row.proxiedCount,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          set: {
            activeNode: row.activeNode,
            aliveNodeCount: row.aliveNodeCount,
            appliedEngineGeneration: row.appliedEngineGeneration,
            appliedRevision: row.appliedRevision,
            arch: row.arch,
            artifactState: row.artifacts,
            engineState: row.engineState,
            engineVersion: row.engineVersion,
            fallbackCount: row.fallbackCount,
            lastError: row.lastError,
            platform: row.platform,
            proxiedCount: row.proxiedCount,
            updatedAt: new Date(),
          },
          target: platformNetworkProxyInstanceStatus.instanceId,
        });
      return true;
    } catch (error) {
      if (isForeignKeyViolation(error)) return false;
      throw error;
    }
  };

  listFresh = async (freshMs: number): Promise<NetworkProxyInstanceStatusFreshRow[]> => {
    const cutoff = new Date(Date.now() - freshMs);
    const rows = await this.db
      .select({
        lastHeartbeatAt: platformInstanceHeartbeats.lastHeartbeatAt,
        status: platformNetworkProxyInstanceStatus,
      })
      .from(platformNetworkProxyInstanceStatus)
      .innerJoin(
        platformInstanceHeartbeats,
        eq(platformNetworkProxyInstanceStatus.instanceId, platformInstanceHeartbeats.instanceId),
      )
      .where(gte(platformInstanceHeartbeats.lastHeartbeatAt, cutoff));

    return rows.map(({ lastHeartbeatAt, status }) => ({
      activeNode: status.activeNode ?? null,
      aliveNodeCount: status.aliveNodeCount ?? null,
      appliedEngineGeneration: status.appliedEngineGeneration ?? null,
      appliedRevision: status.appliedRevision ?? null,
      arch: status.arch,
      artifacts: status.artifactState ?? [],
      engineState: status.engineState,
      engineVersion: status.engineVersion ?? null,
      fallbackCount: status.fallbackCount,
      instanceId: status.instanceId,
      lastError: status.lastError ?? null,
      lastHeartbeatAt,
      platform: status.platform,
      proxiedCount: status.proxiedCount,
      updatedAt: status.updatedAt,
    }));
  };
}
