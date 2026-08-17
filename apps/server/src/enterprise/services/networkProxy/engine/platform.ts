import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { NetworkProxyEnginePlatformKey } from '@/const/platform/networkProxy';
import {
  NETWORK_PROXY_DEFAULT_DATA_DIR_DEV,
  NETWORK_PROXY_DEFAULT_DATA_DIR_DOCKER,
  NETWORK_PROXY_ENV,
  resolveEnginePlatformKey,
} from '@/const/platform/networkProxy';
import { getPlatformInstanceId } from '@/server/enterprise/services/platformInstance/heartbeatRuntime';

const DOCKER_LOBE_DIR = '/app/.lobe';
const REPO_LOOKUP_DEPTH = 6;

export const detectEnginePlatform = (): {
  arch: string;
  key: NetworkProxyEnginePlatformKey | null;
  platform: string;
} => {
  const platform = process.platform;
  const arch = process.arch;
  return { arch, key: resolveEnginePlatformKey(platform, arch), platform };
};

const lookupRepoDataDir = (cwd: string): string | null => {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < REPO_LOOKUP_DEPTH; depth += 1) {
    const marker = path.join(current, 'package.json');
    if (existsSync(marker) && existsSync(path.join(current, '.git'))) {
      return path.resolve(current, NETWORK_PROXY_DEFAULT_DATA_DIR_DEV);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

/**
 * `NETWORK_PROXY_DATA_DIR` → Docker default when `/app/.lobe` exists → repo
 * `.cache/network-proxy` → cwd-relative default.
 */
export const resolveDataDir = (): string => {
  const env = process.env[NETWORK_PROXY_ENV.DATA_DIR];
  if (env && env.trim()) return path.resolve(env.trim());
  if (existsSync(DOCKER_LOBE_DIR)) return NETWORK_PROXY_DEFAULT_DATA_DIR_DOCKER;
  return (
    lookupRepoDataDir(process.cwd()) ??
    path.resolve(process.cwd(), NETWORK_PROXY_DEFAULT_DATA_DIR_DEV)
  );
};

/** Heartbeat instance id, or a process-local fallback when that module is unavailable. */
export const resolveRuntimeInstanceId = (): string => {
  try {
    const id = getPlatformInstanceId();
    if (id) return id;
  } catch {
    // Tests / early boot may not have a heartbeat row.
  }
  return `local_${process.pid}_${randomBytes(4).toString('hex')}`;
};

/**
 * Shared artifact dirs (`engine/`, `geodata/`) plus a per-instance runtime tree:
 * `${dataDir}/runtime/${instanceId}/{config.yaml,mihomo.pid,providers/}`.
 */
export const enginePaths = (dataDir: string, instanceId: string = resolveRuntimeInstanceId()) => {
  const engineDir = path.join(dataDir, 'engine');
  const geodataDir = path.join(dataDir, 'geodata');
  const runtimeRoot = path.join(dataDir, 'runtime');
  const runtimeDir = path.join(runtimeRoot, instanceId);
  return {
    configPath: path.join(runtimeDir, 'config.yaml'),
    engineDir,
    geodataDir,
    instanceId,
    lockPath: path.join(dataDir, 'install.lock'),
    pidPath: path.join(runtimeDir, 'mihomo.pid'),
    providersDir: path.join(runtimeDir, 'providers'),
    runtimeDir,
    runtimeRoot,
  };
};

/** Sibling runtime dirs older than this may be pruned. Config is regenerated at each start. */
export const STALE_SIBLING_RUNTIME_DIR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Prepare this replica's runtime tree and optionally age-prune siblings.
 *
 * NEVER delete a sibling `runtime/<otherId>` based on PID liveness. Replicas
 * that share `NETWORK_PROXY_DATA_DIR` run in separate container PID namespaces,
 * so `process.kill(pid, 0)` cannot observe a sibling's engine and would wipe a
 * live replica's `config.yaml`, pid file, and geodata copies.
 *
 * On start we only (re)create/clean `runtime/<currentInstanceId>` — this
 * process's own leftover files. Sibling dirs are left alone unless their
 * directory mtime is older than 7 days (safe: YAML / pid / providers are
 * regenerated at each start). No PID checks.
 */
export const removeStaleRuntimeDirs = async (
  dataDir: string,
  currentInstanceId: string,
): Promise<void> => {
  const root = path.join(dataDir, 'runtime');
  const currentDir = path.join(root, currentInstanceId);
  await rm(currentDir, { force: true, recursive: true }).catch(() => undefined);
  await mkdir(currentDir, { recursive: true, mode: 0o700 });

  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const cutoff = Date.now() - STALE_SIBLING_RUNTIME_DIR_MS;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === currentInstanceId) return;
      const sibling = path.join(root, entry.name);
      const info = await stat(sibling).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) return;
      await rm(sibling, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
};

export type EnginePaths = ReturnType<typeof enginePaths>;
