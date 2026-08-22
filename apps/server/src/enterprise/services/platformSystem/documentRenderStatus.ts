import type { LobeChatDatabase } from '@/database/type';
import type { AdminSystemGetDocumentRenderStatus } from '@/server/enterprise/contracts/adminSystem';
import {
  getDocumentRenderMaintenanceSummary,
  getDocumentRenderQueueStats,
} from '@/server/enterprise/services/documentRender';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { getDocumentFeedStats } from '@/server/modules/ModelRuntime/documentFeedStats';

import { probeDocumentRenderHealth } from './documentRenderProbe';
import { getLiveInfraHealth } from './infraHealthMemo';

const toIso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const emptyQueue = (): AdminSystemGetDocumentRenderStatus['queue'] => ({
  avgMs: null,
  failed24h: 0,
  p95Ms: null,
  pending: 0,
  recent: [],
  running: 0,
  succeeded24h: 0,
});

const emptyMaintenance = (): AdminSystemGetDocumentRenderStatus['maintenance'] => ({
  artifactBytes: null,
  artifactObjects: null,
  expiredFiles: null,
  jobStatus: null,
  lastError: null,
  lastRunAt: null,
  orphanBytes: null,
  orphanObjects: null,
  tempDirBytes: null,
});

/**
 * Dedicated document-render status for the admin settings/status cards.
 * Sidecar health reuses the 30s infra memo; queue stats are read fresh.
 */
export const getDocumentRenderStatus = async (
  db: LobeChatDatabase,
  now: () => Date = () => new Date(),
): Promise<AdminSystemGetDocumentRenderStatus> => {
  const checkedAt = now();
  const [moduleEnabled, live, queueResult, maintenance] = await Promise.all([
    isModuleEnabled('documentRender'),
    getLiveInfraHealth({
      keyManagementEnv: process.env,
      now,
      objectStorageEnv: process.env,
      probeDocumentRender: () => probeDocumentRenderHealth(now),
    }),
    getDocumentRenderQueueStats(db).catch(() => emptyQueue()),
    getDocumentRenderMaintenanceSummary(db).catch(() => emptyMaintenance()),
  ]);
  const feed = getDocumentFeedStats();

  const queue = {
    avgMs: queueResult.avgMs,
    failed24h: queueResult.failed24h,
    p95Ms: queueResult.p95Ms,
    pending: queueResult.pending,
    recent: queueResult.recent.map((item) => ({
      durationMs: item.durationMs,
      error: item.error,
      ext: item.ext,
      fileId: item.fileId,
      finishedAt: toIso(item.finishedAt),
      id: item.id,
      pages: item.pages,
      status: item.status,
    })),
    running: queueResult.running,
    succeeded24h: queueResult.succeeded24h,
  };

  if (!moduleEnabled) {
    return {
      configured: false,
      feed,
      maintenance,
      moduleEnabled: false,
      queue,
      sidecar: { checkedAt: checkedAt.toISOString(), status: 'disabled' },
    };
  }

  const health = live.documentRender ?? (await probeDocumentRenderHealth(now));
  if (!health) {
    return {
      configured: false,
      feed,
      maintenance,
      moduleEnabled: true,
      queue,
      sidecar: { checkedAt: checkedAt.toISOString(), status: 'disabled' },
    };
  }

  const sidecarStatus = !health.configured
    ? ('unconfigured' as const)
    : health.status === 'healthy'
      ? ('up' as const)
      : ('down' as const);

  return {
    configured: health.configured,
    feed,
    maintenance,
    moduleEnabled: true,
    queue,
    sidecar: {
      checkedAt: (health.lastCheckedAt ?? checkedAt).toISOString(),
      ...(health.lastError ? { error: health.lastError } : {}),
      ...(typeof health.latencyMs === 'number' ? { latencyMs: health.latencyMs } : {}),
      status: sidecarStatus,
      ...(health.version ? { version: health.version } : {}),
    },
  };
};
