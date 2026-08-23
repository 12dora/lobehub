import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

import { removeIfPresent, writeFileAtomically } from './fsSecure';
import { resolveDataDir } from './platform';
import type { SupervisorHandle } from './supervisorHandle';
import { isPidAlive, sleep } from './supervisorHelpers';
import { nextRestartBackoffMs, recordCrashTime } from './supervisorPolicy';

export const spawnEngineProcess = (
  binPath: string,
  runtimeDir: string,
  configPath: string,
): ChildProcess => {
  const env = {
    HOME: runtimeDir,
    PATH: process.env.PATH,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    TZ: process.env.TZ,
  };
  return spawn(binPath, ['-d', runtimeDir, '-f', configPath], {
    env: env as unknown as typeof process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

export const killStalePid = async (binPath: string, pidPath: string): Promise<void> => {
  let raw: string;
  try {
    raw = await readFile(pidPath, 'utf8');
  } catch {
    return;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    await removeIfPresent(pidPath);
    return;
  }
  // Darwin (and any host without /proc/<pid>/exe): never kill an unverified identity.
  if (process.platform === 'darwin') return;
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`);
    if (path.resolve(exe) !== path.resolve(binPath)) return;
  } catch {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await sleep(500);
  await removeIfPresent(pidPath);
};

export const writePidFile = async (pid: number, pidPath: string): Promise<void> => {
  await writeFileAtomically({
    contents: String(pid),
    mode: 0o600,
    path: pidPath,
    root: resolveDataDir(),
  });
};

export const installProcessHooks = (getChild: () => ChildProcess | null): void => {
  const killSync = () => {
    try {
      getChild()?.kill('SIGTERM');
    } catch {
      // best-effort
    }
  };
  const reraise = (signal: NodeJS.Signals) => {
    killSync();
    process.kill(process.pid, signal);
  };
  process.once('SIGTERM', () => reraise('SIGTERM'));
  process.once('SIGINT', () => reraise('SIGINT'));
  process.once('exit', killSync);
};

export const stopEngineNow = async (host: SupervisorHandle): Promise<void> => {
  host.desiredStop = true;
  host.stopHealthLoop();
  const child = host.child;
  host.child = null;
  host.rest = null;
  if (child?.pid && isPidAlive(child.pid)) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveWait) => child.once('exit', () => resolveWait())),
      sleep(2000),
    ]);
    if (child.pid && isPidAlive(child.pid)) child.kill('SIGKILL');
  }
  host.controllerSecret = null;
  host.listenerPassword = null;
  host.mixedPort = null;
  host.controllerPort = null;
  host.startedAt = null;
  await removeIfPresent(host.paths().pidPath);
  host.patchState({
    controller: null,
    proxyUrl: null,
    startedAt: null,
  });
};

export const onChildExit = async (
  host: SupervisorHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> => {
  if (host.starting || host.desiredStop) {
    host.child = null;
    return;
  }
  await host.runExclusive(async () => {
    host.child = null;
    host.stopHealthLoop();
    host.rest = null;
    host.controllerSecret = null;
    host.listenerPassword = null;
    host.mixedPort = null;
    host.controllerPort = null;
    await removeIfPresent(host.paths().pidPath);
    if (host.desiredStop) {
      host.desiredStop = false;
      return;
    }
    const now = Date.now();
    host.crashTimes = recordCrashTime(host.crashTimes, now, host.crashWindowMs);
    const exitError = new Error(`engine exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    if (host.crashTimes.length >= host.crashLimit) {
      host.setIssue('crash_loop', exitError);
      host.enterErrorState();
      return;
    }
    host.setIssue('exited', exitError);
    host.backoffMs = nextRestartBackoffMs(
      host.backoffMs,
      NETWORK_PROXY_LIMITS.ENGINE_RESTART_BACKOFF_MAX_MS,
    );
    await sleep(host.backoffMs);
    await host.startEngineNow();
  });
};
