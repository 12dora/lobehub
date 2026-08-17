import debug from 'debug';

import { getPlatformInstanceId } from '@/server/enterprise/services/platformInstance/heartbeatRuntime';
import type { EngineIssue, InstanceHealing } from '@/types/platform/networkProxy';

import { getEgressCounters } from '../egress/counters';
import { artifactManager } from './artifacts';
import type { InstanceStatusUpsert } from './b1';
import { redactSecrets, upsertInstanceStatus } from './b1';
import { detectEnginePlatform } from './platform';
import type { EngineRuntime, EngineRuntimeState } from './types';

export const INSTANCE_STATUS_STATE_CHANGE_DEBOUNCE_MS = 2000;

const sanitizeIssue = (issue: EngineIssue | null): EngineIssue | null => {
  if (!issue) return null;
  const detail = issue.detail ? redactSecrets(issue.detail).slice(0, 200) : null;
  return { ...issue, detail: detail || null };
};

const projectHealing = (state: EngineRuntimeState): InstanceHealing | null => {
  if (state.state !== 'error' || state.nextHealAt === null) return null;
  return {
    attempt: Math.max(state.healAttempts, 1),
    nextAttemptAt: new Date(state.nextHealAt).toISOString(),
  };
};

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

/** The answering instance's live status row (what the reporter would upsert). */
export const buildLocalInstanceStatus = async (
  runtime: EngineRuntime,
): Promise<InstanceStatusUpsert> => {
  const state = runtime.getState();
  const artifacts = await artifactManager.getStatus();
  const { arch, platform } = detectEnginePlatform();
  const counters = loadEgressCounters();
  return {
    activeNode: state.activeNode,
    aliveNodeCount: state.aliveNodeCount,
    appliedEngineGeneration: state.appliedEngineGeneration,
    appliedRevision: state.appliedRevision,
    arch,
    artifacts,
    engineState: state.state,
    engineVersion: state.version,
    fallbackCount: counters.fallback,
    healing: projectHealing(state),
    instanceId: getPlatformInstanceId(),
    lastIssue: sanitizeIssue(state.lastIssue),
    platform,
    proxiedCount: counters.proxied,
  };
};

export const reportInstanceStatus = async (runtime: EngineRuntime): Promise<boolean> => {
  const db = await loadDb();
  if (!db) return false;
  try {
    return await upsertInstanceStatus(db, await buildLocalInstanceStatus(runtime));
  } catch (error) {
    // Heartbeat row may not exist yet — B1 already swallows the FK miss.
    if (error instanceof Error && /foreign key/i.test(error.message)) return false;
    throw error;
  }
};

export const startInstanceStatusReporter = (
  runtime: EngineRuntime,
  intervalMs = 30_000,
  report: (runtime: EngineRuntime) => Promise<boolean> = reportInstanceStatus,
  debounceMs = INSTANCE_STATUS_STATE_CHANGE_DEBOUNCE_MS,
): (() => void) => {
  let inFlight = false;
  let dirty = false;
  let lastWriteAt = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    dirty = false;
    lastWriteAt = Date.now();
    void report(runtime)
      .catch((error) => {
        log(
          'report failed instanceId=%s errorClass=%s',
          getPlatformInstanceId(),
          error instanceof Error ? redactSecrets(error.name) : 'UnknownError',
        );
      })
      .finally(() => {
        inFlight = false;
        if (dirty) write();
      });
  };

  const tickFromTimer = () => {
    write();
  };

  const tickFromStateChange = () => {
    if (inFlight) {
      dirty = true;
      return;
    }
    const elapsed = Date.now() - lastWriteAt;
    if (lastWriteAt > 0 && elapsed < debounceMs) {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        write();
      }, debounceMs - elapsed);
      debounceTimer.unref();
      return;
    }
    write();
  };

  const timer = setInterval(tickFromTimer, intervalMs);
  timer.unref();
  const unsubscribe = runtime.onStateChange(() => tickFromStateChange());
  write();
  return () => {
    clearInterval(timer);
    if (debounceTimer) clearTimeout(debounceTimer);
    unsubscribe();
  };
};
