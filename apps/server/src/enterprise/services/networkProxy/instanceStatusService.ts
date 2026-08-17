import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import { NetworkProxyInstanceStatusModel } from '@/database/models/platform/networkProxyInstanceStatus';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ArtifactState,
  EngineIssue,
  InstanceHealing,
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
  healing: InstanceHealing | null;
  instanceId: string;
  lastIssue: EngineIssue | null;
  platform: string;
  proxiedCount: number;
}

const sanitizeIssue = (issue: EngineIssue | null): EngineIssue | null => {
  if (!issue) return null;
  const detail = issue.detail ? redactSecrets(issue.detail).slice(0, 200) : null;
  return { ...issue, detail: detail || null };
};

export const upsertInstanceStatus = async (
  db: LobeChatDatabase,
  row: InstanceStatusUpsert,
): Promise<boolean> =>
  new NetworkProxyInstanceStatusModel(db).upsert({
    ...row,
    lastIssue: sanitizeIssue(row.lastIssue),
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
    healing: row.healing,
    instanceId: row.instanceId,
    isCurrent: row.instanceId === currentInstanceId,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    lastIssue: sanitizeIssue(row.lastIssue),
    platform: row.platform,
    proxiedCount: row.proxiedCount,
    updatedAt: row.updatedAt.toISOString(),
  }));
};
