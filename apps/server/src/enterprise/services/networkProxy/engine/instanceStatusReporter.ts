import debug from 'debug';

import { getPlatformInstanceId } from '@/server/enterprise/services/platformInstance/heartbeatRuntime';

import { getEgressCounters } from '../egress/counters';
import { artifactManager } from './artifacts';
import { redactSecrets, upsertInstanceStatus } from './b1';
import { detectEnginePlatform } from './platform';
import type { EngineRuntime } from './types';

const log = debug('lobe-server:network-proxy-status');

const loadDb = async () => {
  try {
    const { getServerDB } = await import('@/database/core/db-adaptor');
    return await getServerDB();
  } catch {
    return null;
  }
};

const loadEgressCounters = (): { fallback: number; proxied: number } => {
  const counts = getEgressCounters();
  return {
    fallback: Object.values(counts.fallback).reduce((sum, value) => sum + value, 0),
    proxied: Object.values(counts.proxied).reduce((sum, value) => sum + value, 0),
  };
};

export const reportInstanceStatus = async (runtime: EngineRuntime): Promise<boolean> => {
  const db = await loadDb();
  if (!db) return false;
  const state = runtime.getState();
  const artifacts = await artifactManager.getStatus();
  const { arch, platform } = detectEnginePlatform();
  const counters = loadEgressCounters();
  try {
    return await upsertInstanceStatus(db, {
      activeNode: state.activeNode,
      aliveNodeCount: state.aliveNodeCount,
      appliedEngineGeneration: state.appliedEngineGeneration,
      appliedRevision: state.appliedRevision,
      arch,
      artifacts,
      engineState: state.state,
      engineVersion: state.version,
      fallbackCount: counters.fallback,
      instanceId: getPlatformInstanceId(),
      lastError: state.lastError ? redactSecrets(state.lastError) : null,
      platform,
      proxiedCount: counters.proxied,
    });
  } catch (error) {
    // Heartbeat row may not exist yet — B1 already swallows the FK miss.
    if (error instanceof Error && /foreign key/i.test(error.message)) return false;
    throw error;
  }
};

export const startInstanceStatusReporter = (
  runtime: EngineRuntime,
  intervalMs = 30_000,
): (() => void) => {
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void reportInstanceStatus(runtime)
      .catch((error) => {
        log(
          'report failed instanceId=%s errorClass=%s',
          getPlatformInstanceId(),
          error instanceof Error ? redactSecrets(error.name) : 'UnknownError',
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const unsubscribe = runtime.onStateChange(() => tick());
  tick();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
};
