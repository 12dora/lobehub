import type { NetworkProxyEngineIssueCode } from '@/const/platform/networkProxy';
import type { EngineIssue } from '@/types/platform/networkProxy';

import { redactSecrets } from './b1';
import { resolveEngineIssueCode } from './errors';

export const PORT_RETRY = 3;
export const DEFAULT_START_WAIT_MS = 8_000;
export const HEALTH_POLL_MS = 400;

export const INFORMATIONAL_ISSUE_CODES: ReadonlySet<NetworkProxyEngineIssueCode> = new Set([
  'geodata_missing',
  'geodata_invalid',
]);

export const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TimeoutError';

export const isPortsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  // Match port/ports as words so the unsupported-platform sentinel is not treated as a port error.
  return /\bports?\b|EADDRINUSE|EADDRNOTAVAIL/i.test(error.message);
};

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const sleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

export type ProxyDetail = {
  alive?: boolean;
  history?: { delay: number }[];
  name?: string;
  type: string;
};

export const memberAlive = (
  proxy: { alive?: boolean; history?: { delay: number }[] } | undefined,
): boolean => {
  if (!proxy) return false;
  if (proxy.alive === true) return true;
  const last = proxy.history?.at(-1)?.delay ?? 0;
  return last > 0;
};

export const makeIssue = (code: NetworkProxyEngineIssueCode, error?: unknown): EngineIssue => {
  const raw = error instanceof Error ? error.message : error !== undefined ? String(error) : null;
  const detail = raw ? redactSecrets(raw).slice(0, 200) : null;
  return {
    at: new Date().toISOString(),
    code,
    detail: detail || null,
  };
};

export const pickInformationalIssue = (lastIssue: EngineIssue | null): EngineIssue | null =>
  lastIssue && INFORMATIONAL_ISSUE_CODES.has(lastIssue.code) ? lastIssue : null;

export const issueCodeForStartFailure = (
  error: unknown,
  afterSpawn: boolean,
): NetworkProxyEngineIssueCode => {
  if (afterSpawn) return 'start_timeout';
  if (isPortsError(error)) return 'ports_unavailable';
  const mapped = resolveEngineIssueCode(error);
  if (mapped === 'health_timeout' || isTimeoutError(error)) return 'start_timeout';
  return mapped;
};
