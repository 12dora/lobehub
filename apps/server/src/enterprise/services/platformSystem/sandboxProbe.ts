import type { AdminSystemSandboxHealth } from '@/server/enterprise/contracts/adminSystem';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import { getEffectiveSandboxSettings } from '@/server/enterprise/services/sandboxSettings/effective';
import type { LocalSandboxHealth } from '@/server/services/sandbox/providers/local';

import { probeLatencyMs } from './infraProbes';

const LAST_ERROR_MAX = 500;

const clipError = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > LAST_ERROR_MAX ? trimmed.slice(0, LAST_ERROR_MAX) : trimmed;
};

export const projectSandboxHealth = (
  health: LocalSandboxHealth,
  maxContainers: number,
  checkedAt: Date,
): AdminSystemSandboxHealth => {
  const lastError = clipError(health.lastError);
  const base = {
    activeContainers: health.activeContainers,
    daemonReachable: health.daemonReachable,
    detail: 'Docker',
    imagePresent: health.imagePresent,
    lastCheckedAt: checkedAt,
    maxContainers,
    ...(lastError ? { lastError } : {}),
  };

  if (!health.daemonReachable) {
    return {
      ...base,
      errorCategory: 'operation_unavailable',
      imagePresent: false,
      status: 'unavailable',
    };
  }

  if (!health.imagePresent) {
    return {
      ...base,
      errorCategory: 'configuration_incomplete',
      status: 'degraded',
    };
  }

  if (lastError) {
    return {
      ...base,
      errorCategory: 'operation_unavailable',
      status: 'degraded',
    };
  }

  return {
    ...base,
    errorCategory: null,
    status: 'healthy',
  };
};

export type SandboxHealthProbe = () => Promise<AdminSystemSandboxHealth | null>;

/**
 * Live sandbox probe for the system-status page. Returns null when the module is
 * off or the effective provider is not local — the UI hides the row in that case.
 */
export const probeSandboxHealth = async (
  now: () => Date = () => new Date(),
): Promise<AdminSystemSandboxHealth | null> => {
  const moduleEnabled = await isModuleEnabled('sandbox');
  if (!moduleEnabled) {
    console.warn('[platformSystem] sandbox probe skipped: module disabled');
    return null;
  }
  const settings = await getEffectiveSandboxSettings();
  if (settings.provider !== 'local') {
    console.warn(
      `[platformSystem] sandbox probe skipped: provider=${settings.provider} (source=${settings.source})`,
    );
    return null;
  }

  const { checkLocalSandboxHealth } = await import('@/server/services/sandbox/providers/local');
  const startedAt = performance.now();
  try {
    const health = await checkLocalSandboxHealth({
      host: settings.dockerHost,
      image: settings.image,
      socketPath: settings.dockerSocket,
    });
    return {
      ...projectSandboxHealth(health, settings.maxContainers, now()),
      latencyMs: probeLatencyMs(startedAt),
    };
  } catch (error) {
    return {
      ...projectSandboxHealth(
        {
          activeContainers: 0,
          daemonReachable: false,
          imagePresent: false,
          lastError: error instanceof Error ? error.message : 'unreachable',
        },
        settings.maxContainers,
        now(),
      ),
      latencyMs: probeLatencyMs(startedAt),
    };
  }
};
