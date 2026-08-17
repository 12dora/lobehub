// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';

import {
  detectEnginePlatform,
  enginePaths,
  removeStaleRuntimeDirs,
  resolveDataDir,
  STALE_SIBLING_RUNTIME_DIR_MS,
} from './platform';

const previous = process.env[NETWORK_PROXY_ENV.DATA_DIR];

afterEach(() => {
  if (previous === undefined) delete process.env[NETWORK_PROXY_ENV.DATA_DIR];
  else process.env[NETWORK_PROXY_ENV.DATA_DIR] = previous;
});

describe('detectEnginePlatform', () => {
  it('returns the current process platform and a key when supported', () => {
    const detected = detectEnginePlatform();
    expect(detected.platform).toBe(process.platform);
    expect(detected.arch).toBe(process.arch);
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(detected.key).toBe('darwin:arm64');
    }
  });
});

describe('resolveDataDir', () => {
  it('prefers NETWORK_PROXY_DATA_DIR when set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'np-data-'));
    process.env[NETWORK_PROXY_ENV.DATA_DIR] = dir;
    expect(resolveDataDir()).toBe(dir);
    rmSync(dir, { force: true, recursive: true });
  });
});

describe('enginePaths', () => {
  it('namespaces mutable runtime state by instance id; artifacts stay shared', () => {
    const paths = enginePaths('/tmp/network-proxy', 'pinst_test');
    expect(paths.engineDir).toBe('/tmp/network-proxy/engine');
    expect(paths.geodataDir).toBe('/tmp/network-proxy/geodata');
    expect(paths.runtimeDir).toBe('/tmp/network-proxy/runtime/pinst_test');
    expect(paths.configPath).toBe('/tmp/network-proxy/runtime/pinst_test/config.yaml');
    expect(paths.pidPath).toBe('/tmp/network-proxy/runtime/pinst_test/mihomo.pid');
    expect(paths.providersDir).toBe('/tmp/network-proxy/runtime/pinst_test/providers');
    expect(paths.lockPath).toBe('/tmp/network-proxy/install.lock');
    expect(paths.instanceId).toBe('pinst_test');
  });
});

describe('removeStaleRuntimeDirs', () => {
  it('recreates the current instance dir and never PID-deletes recent siblings', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'np-rt-'));
    const currentDir = path.join(root, 'runtime', 'current');
    const recentDead = path.join(root, 'runtime', 'recent-dead');
    const recentLive = path.join(root, 'runtime', 'recent-live');
    const ancient = path.join(root, 'runtime', 'ancient');
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(recentDead, { recursive: true });
    mkdirSync(recentLive, { recursive: true });
    mkdirSync(ancient, { recursive: true });
    writeFileSync(path.join(currentDir, 'leftover.yaml'), 'stale');
    writeFileSync(path.join(recentDead, 'mihomo.pid'), '99999999');
    writeFileSync(path.join(recentLive, 'mihomo.pid'), String(process.pid));
    writeFileSync(path.join(ancient, 'mihomo.pid'), String(process.pid));
    const old = new Date(Date.now() - STALE_SIBLING_RUNTIME_DIR_MS - 24 * 60 * 60 * 1000);
    utimesSync(ancient, old, old);

    await removeStaleRuntimeDirs(root, 'current');

    expect(existsSync(currentDir)).toBe(true);
    expect(existsSync(path.join(currentDir, 'leftover.yaml'))).toBe(false);
    // Dead/live PID must not decide sibling deletion across container namespaces.
    expect(existsSync(recentDead)).toBe(true);
    expect(existsSync(recentLive)).toBe(true);
    expect(existsSync(ancient)).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });
});

describe('ensureSecureDirectory', () => {
  it('refuses a symlink target', async () => {
    const { ensureSecureDirectory } = await import('./fsSecure');
    const root = mkdtempSync(path.join(tmpdir(), 'np-link-'));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    await expect(ensureSecureDirectory(link, { create: false, root })).rejects.toThrow(/symlink/i);
    rmSync(root, { force: true, recursive: true });
  });
});
