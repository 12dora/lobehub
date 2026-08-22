import { getServerDB } from '@/database/core/db-adaptor';
import type {
  AdminSystemDocumentRenderHealth,
  AdminSystemTestDependencyReason,
} from '@/server/enterprise/contracts/adminSystem';
import {
  getDocumentRenderQueueStats,
  probeGotenberg,
} from '@/server/enterprise/services/documentRender';
import {
  getEffectiveDocumentRenderSettings,
  isDocumentRenderConfigured,
} from '@/server/enterprise/services/documentRenderSettings';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';

const LAST_ERROR_MAX = 500;
const PROBE_TIMEOUT_MS = 5000;

const clipError = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > LAST_ERROR_MAX ? trimmed.slice(0, LAST_ERROR_MAX) : trimmed;
};

const emptyQueue = { pending: 0, running: 0 };

const loadQueueCounts = async (): Promise<{ pending: number; running: number }> => {
  try {
    const db = await getServerDB();
    const stats = await getDocumentRenderQueueStats(db);
    return { pending: stats.pending, running: stats.running };
  } catch {
    return emptyQueue;
  }
};

const classifyProbeError = (
  error: string | undefined,
): AdminSystemDocumentRenderHealth['errorCategory'] => {
  if (error && /timeout|abort/i.test(error)) return 'timeout';
  return 'operation_unavailable';
};

export type DocumentRenderHealthProbe = () => Promise<AdminSystemDocumentRenderHealth | null>;

/**
 * Live document-render probe for the system-status page. Returns null when the
 * module is off — the UI hides the row in that case.
 */
export const probeDocumentRenderHealth = async (
  now: () => Date = () => new Date(),
): Promise<AdminSystemDocumentRenderHealth | null> => {
  if (!(await isModuleEnabled('documentRender'))) return null;

  const checkedAt = now();
  const settings = await getEffectiveDocumentRenderSettings();
  const queue = await loadQueueCounts();
  const lastErrorBase = {
    configured: isDocumentRenderConfigured(settings),
    detail: 'Gotenberg',
    lastCheckedAt: checkedAt,
    queuePending: queue.pending,
    queueRunning: queue.running,
  };

  if (!settings.endpoint) {
    return {
      ...lastErrorBase,
      configured: false,
      errorCategory: 'configuration_incomplete',
      status: 'degraded',
    };
  }

  try {
    const result = await probeGotenberg(settings.endpoint, PROBE_TIMEOUT_MS);
    const lastError = clipError(result.error);
    if (result.ok) {
      return {
        ...lastErrorBase,
        errorCategory: null,
        ...(typeof result.latencyMs === 'number' ? { latencyMs: result.latencyMs } : {}),
        status: 'healthy',
        ...(result.version ? { version: result.version } : {}),
      };
    }
    return {
      ...lastErrorBase,
      errorCategory: classifyProbeError(result.error),
      ...(typeof result.latencyMs === 'number' ? { latencyMs: result.latencyMs } : {}),
      status: 'unavailable',
      ...(lastError ? { lastError } : {}),
    };
  } catch (error) {
    const lastError = clipError(error instanceof Error ? error.message : 'unreachable');
    return {
      ...lastErrorBase,
      errorCategory: classifyProbeError(lastError),
      status: 'unavailable',
      ...(lastError ? { lastError } : {}),
    };
  }
};

const mapProbeMessage = (error: string | undefined): AdminSystemTestDependencyReason => {
  if (!error) return 'unreachable';
  if (/timeout|abort/i.test(error)) return 'timeout';
  if (/401|403|unauthorized/i.test(error)) return 'unauthorized';
  return 'unreachable';
};

/** Bounded Gotenberg `/health` probe for `admin.system.testDependency`. */
export const testDocumentRenderDependency = async (
  now: () => Date = () => new Date(),
): Promise<{
  checkedAt: Date;
  latencyMs: number;
  message?: AdminSystemTestDependencyReason;
  ok: boolean;
}> => {
  const started = Date.now();
  const checkedAt = now();
  const settings = await getEffectiveDocumentRenderSettings();
  if (!settings.endpoint) {
    return {
      checkedAt,
      latencyMs: Date.now() - started,
      message: 'not_configured',
      ok: false,
    };
  }

  const result = await probeGotenberg(settings.endpoint, PROBE_TIMEOUT_MS);
  if (result.ok) {
    return { checkedAt, latencyMs: result.latencyMs, ok: true };
  }
  return {
    checkedAt,
    latencyMs: result.latencyMs,
    message: mapProbeMessage(result.error),
    ok: false,
  };
};
