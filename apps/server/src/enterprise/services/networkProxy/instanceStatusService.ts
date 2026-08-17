import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import { NetworkProxyInstanceStatusModel } from '@/database/models/platform/networkProxyInstanceStatus';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ArtifactState,
  InstanceStatusView,
  NetworkProxyEngineState,
} from '@/types/platform/networkProxy';

import { redactSecrets } from './redact';

export interface InstanceStatusUpsert {
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

export const upsertInstanceStatus = async (
  db: LobeChatDatabase,
  row: InstanceStatusUpsert,
): Promise<boolean> =>
  new NetworkProxyInstanceStatusModel(db).upsert({
    ...row,
    lastError: row.lastError ? redactSecrets(row.lastError) : row.lastError,
  });

export const listFreshInstanceStatuses = async (
  db: LobeChatDatabase,
  currentInstanceId: string,
): Promise<InstanceStatusView[]> => {
  const rows = await new NetworkProxyInstanceStatusModel(db).listFresh(
    NETWORK_PROXY_LIMITS.INSTANCE_FRESH_MS,
  );
  return rows.map((row) => ({
    activeNode: row.activeNode,
    aliveNodeCount: row.aliveNodeCount,
    appliedRevision: row.appliedRevision,
    arch: row.arch,
    artifacts: row.artifacts,
    engineState: row.engineState,
    engineVersion: row.engineVersion,
    fallbackCount: row.fallbackCount,
    instanceId: row.instanceId,
    isCurrent: row.instanceId === currentInstanceId,
    lastError: row.lastError ? redactSecrets(row.lastError) : row.lastError,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    platform: row.platform,
    proxiedCount: row.proxiedCount,
    updatedAt: row.updatedAt.toISOString(),
  }));
};
