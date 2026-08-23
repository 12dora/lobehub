import type { NetworkProxyEngineState } from '@/const/platform/networkProxy';
import type { EngineIssue } from '@/types/platform/networkProxy';

import type { InstalledArtifact } from './artifacts';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import { isLegacyGlobalProxyActive } from './b1';
import { detectEnginePlatform } from './platform';
import { makeIssue } from './supervisorHelpers';

export const healBackoffMs = (attempts: number, baseMs: number, maxMs: number): number => {
  const n = Math.max(attempts, 1);
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
};

export const isDesiredEngineRun = (
  snapshot: NetworkProxyRuntimeSnapshot,
  binary: InstalledArtifact | null,
): boolean =>
  snapshot.config.masterEnabled &&
  snapshot.config.outlet.kind === 'engine' &&
  Boolean(binary) &&
  !isLegacyGlobalProxyActive();

export const isUnattemptedGeneration = (
  generation: number,
  lastAttempted: number | null,
  applied: number | null,
): boolean => generation > (lastAttempted ?? applied ?? -1);

export const nextHealOnEnterError = (
  healAttempts: number,
  nextHealAt: number | null,
  baseMs: number,
  maxMs: number,
  now: number,
): { healAttempts: number; nextHealAt: number } => {
  if (nextHealAt === null) {
    const attempts = Math.max(healAttempts, 1);
    return { healAttempts: attempts, nextHealAt: now + healBackoffMs(attempts, baseMs, maxMs) };
  }
  return { healAttempts, nextHealAt };
};

export const stoppedStateFor = (
  binary: InstalledArtifact | null,
  reason: 'desired' | 'failure',
  currentIssue: EngineIssue | null,
): { lastIssue: EngineIssue | null; nextState: NetworkProxyEngineState } => {
  const { key } = detectEnginePlatform();
  const nextState = key ? (binary ? 'stopped' : 'not_installed') : 'unsupported';
  const lastIssue =
    reason === 'desired'
      ? nextState === 'unsupported'
        ? makeIssue('unsupported_platform')
        : null
      : currentIssue;
  return { lastIssue, nextState };
};

export const nextRestartBackoffMs = (backoffMs: number, maxMs: number): number =>
  Math.min(backoffMs * 2, maxMs);

export const recordCrashTime = (
  crashTimes: number[],
  now: number,
  crashWindowMs: number,
): number[] => crashTimes.filter((at) => now - at <= crashWindowMs).concat(now);
