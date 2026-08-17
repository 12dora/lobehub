// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NETWORK_PROXY_ENGINE_MANIFEST, NETWORK_PROXY_ENV } from '@/const/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import {
  resetArtifactCachesForTest,
  setAfterReverifyForTest,
  setResolveArtifactSpecForTest,
} from './artifacts';
import type * as B1 from './b1';
import type { NetworkProxyRuntimeSnapshot } from './b1';
import { enginePaths } from './platform';
import { setAfterWriteGeneratedConfigForTest } from './supervisor';
import { idleEngineRuntimeState } from './types';

const { snapshotHolder } = vi.hoisted(() => ({
  snapshotHolder: {
    current: null as NetworkProxyRuntimeSnapshot | null,
  },
}));

vi.mock('./b1', async () => {
  const actual = await vi.importActual<typeof B1>('./b1');
  return {
    ...actual,
    getNetworkProxySnapshot: vi.fn(async () => snapshotHolder.current!),
    isLegacyGlobalProxyActive: vi.fn(() => false),
    onNetworkProxySnapshotChange: vi.fn(() => () => undefined),
  };
});

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/fakeMihomo.mjs',
);

const makeSnapshot = (
  patch: Partial<NetworkProxyRuntimeSnapshot['config']> = {},
): NetworkProxyRuntimeSnapshot => ({
  config: { ...createDefaultNetworkProxyConfig(), masterEnabled: true, ...patch },
  desiredArtifacts: {},
  engineGeneration: 1,
  loadedAt: Date.now(),
  revision: 1,
  staticProxyUrl: null,
  subscriptions: [],
});

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for supervisor state');
};

let dataDir: string;
let startsFile: string;
let wrapper: string;
const live: Array<{ restart: () => Promise<void> }> = [];

const writeWrapper = (extra: Record<string, string> = {}) => {
  const exports = Object.entries({ FAKE_ENGINE_STARTS_FILE: startsFile, ...extra })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n');
  writeFileSync(
    wrapper,
    `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'np-sup-'));
  startsFile = path.join(dataDir, 'starts');
  writeFileSync(startsFile, '');
  wrapper = path.join(dataDir, 'fake-engine');
  writeWrapper();
  process.env[NETWORK_PROXY_ENV.DATA_DIR] = dataDir;
  process.env[NETWORK_PROXY_ENV.ENGINE_BIN] = wrapper;
  snapshotHolder.current = makeSnapshot();
});

afterEach(async () => {
  setAfterWriteGeneratedConfigForTest(null);
  snapshotHolder.current = makeSnapshot({ masterEnabled: false });
  await Promise.all(
    live.splice(0).map((supervisor) => supervisor.restart().catch(() => undefined)),
  );
  delete process.env[NETWORK_PROXY_ENV.ENGINE_BIN];
  setResolveArtifactSpecForTest(null);
  resetArtifactCachesForTest();
  rmSync(dataDir, { force: true, recursive: true });
});

describe('EngineSupervisor idle / stop conditions', () => {
  it('stays stopped when masterEnabled is false', async () => {
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 500 });
    await supervisor.reconcile();
    expect(['not_installed', 'stopped', 'unsupported']).toContain(supervisor.getState().state);
    expect(supervisor.getState().proxyUrl).toBeNull();
    expect(supervisor.getState().controller).toBeNull();
    expect(supervisor.getState().appliedRevision).toBeNull();
  });

  it('exposes an idle state without leaking credentials', () => {
    const idle = idleEngineRuntimeState('stopped');
    expect(idle.proxyUrl).toBeNull();
    expect(idle.controller).toBeNull();
    expect(idle.lastIssue).toBeNull();
    expect(idle.healAttempts).toBe(0);
    expect(idle.nextHealAt).toBeNull();
  });
});

describe('EngineSupervisor child process', () => {
  it('starts and reports running', async () => {
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 4000 });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(supervisor.getState().appliedRevision).toBe(1);
    expect(supervisor.getState().appliedEngineGeneration).toBe(1);
    expect(supervisor.getState().proxyUrl).toContain('127.0.0.1');
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
    expect(supervisor.getState().state).toBe('stopped');
  });

  it('sees provider-sourced members as alive (they are absent from GET /proxies)', async () => {
    writeWrapper({ FAKE_ENGINE_PROVIDER_NODE: '1' });
    try {
      const { EngineSupervisor } = await import('./supervisor');
      const supervisor = new EngineSupervisor({ healthIntervalMs: 60, startWaitMs: 4000 });
      live.push(supervisor);
      await supervisor.reconcile();
      await waitFor(() => supervisor.getState().aliveNodeCount === 1);
      expect(supervisor.getState().state).toBe('running');
      expect(supervisor.getState().activeNode).toBe('n1');
      const nodes = await supervisor.listNodes();
      expect(nodes).toEqual([
        { alive: true, delayMs: 75, name: 'n1', subscriptionId: 'abc', type: 'Http' },
      ]);
    } finally {
      writeWrapper();
    }
  });

  it('restarts after health failures and serializes concurrent restart()', async () => {
    writeWrapper({ FAKE_ENGINE_FAIL_AFTER: '1' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healthFailuresBeforeRestart: 2,
      healthIntervalMs: 60,
      startWaitMs: 4000,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    await waitFor(() => readFileSync(startsFile, 'utf8').length >= 2, 10_000);
    writeWrapper({ FAKE_ENGINE_FAIL_AFTER: '9999' });
    const before = readFileSync(startsFile, 'utf8').length;
    await Promise.all([supervisor.restart(), supervisor.restart()]);
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    const after = readFileSync(startsFile, 'utf8').length;
    expect(after - before).toBe(1);
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 15_000);

  it('enters error after the crash limit', async () => {
    writeWrapper({ FAKE_ENGINE_CRASH_AFTER_MS: '800' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      crashLimit: 2,
      crashWindowMs: 60_000,
      startWaitMs: 4000,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(() => supervisor.getState().state === 'error', 10_000);
    expect(supervisor.getState().lastIssue?.code).toBe('crash_loop');
    expect(supervisor.getState().appliedRevision).toBe(1);
    expect(supervisor.getState().nextHealAt).toBeGreaterThan(Date.now());
  }, 15_000);

  it('does not advance applied state when start fails', async () => {
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '3' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 400 });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    expect(supervisor.getState().appliedRevision).toBeNull();
    // Success-path only: a failed start must not pretend the generation applied.
    expect(supervisor.getState().appliedEngineGeneration).toBeNull();
    expect(supervisor.getState().lastIssue?.code).toBe('start_timeout');
    expect(supervisor.getState().nextHealAt).toBeGreaterThan(Date.now());
  });

  it('does not materialize geodata in simple mode even if files exist', async () => {
    const commit = NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit;
    const destParent = path.join(dataDir, 'geodata', commit);
    mkdirSync(destParent, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(destParent, 'geoip.metadb'), 'junk');
    writeFileSync(path.join(destParent, 'geosite.dat'), 'junk');
    snapshotHolder.current = makeSnapshot({ ruleMode: 'simple' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 4000 });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    const runtimeGeo = path.join(enginePaths(dataDir).runtimeDir, 'geoip.metadb');
    expect(existsSync(runtimeGeo)).toBe(false);
    expect(supervisor.getState().lastIssue).toBeNull();
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 12_000);

  it('starts in smart mode when geodata is invalid and notes geodata_invalid', async () => {
    const commit = NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit;
    const destParent = path.join(dataDir, 'geodata', commit);
    mkdirSync(destParent, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(destParent, 'geoip.metadb'), 'junk');
    writeFileSync(path.join(destParent, 'geosite.dat'), 'junk');
    snapshotHolder.current = makeSnapshot({ ruleMode: 'smart' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 4000 });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(supervisor.getState().lastIssue?.code).toBe('geodata_invalid');
    expect(['running', 'degraded']).toContain(supervisor.getState().state);
    const config = readFileSync(enginePaths(dataDir).configPath, 'utf8');
    expect(config).not.toContain('GEOSITE,cn,DIRECT');
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 12_000);

  it('refuses a mutated engine file on the next spawn attempt', async () => {
    const destParent = path.join(dataDir, 'engine', NETWORK_PROXY_ENGINE_MANIFEST.version);
    mkdirSync(destParent, { recursive: true, mode: 0o700 });
    const dest = path.join(destParent, 'mihomo-testbin');
    writeFileSync(dest, readFileSync(wrapper));
    chmodSync(dest, 0o500);
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(readFileSync(dest)).digest('hex');
    setResolveArtifactSpecForTest(() => ({
      compressed: 'none',
      destName: 'mihomo-testbin',
      destParent,
      downloadUrl: 'https://example.com/x',
      kind: 'engine',
      mode: 0o500,
      sha256: digest,
      size: readFileSync(dest).length,
      version: NETWORK_PROXY_ENGINE_MANIFEST.version,
    }));
    delete process.env[NETWORK_PROXY_ENV.ENGINE_BIN];
    let first = true;
    setAfterReverifyForTest(() => {
      if (!first) return;
      first = false;
      writeFileSync(dest, 'mutated-bytes-that-do-not-match');
    });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 400 });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    expect(supervisor.getState().appliedRevision).toBeNull();
    // First attempt spawns the just-mutated file (start_timeout). Later retries
    // re-verify and map to artifact_mismatch when the digest check fires first.
    expect(['start_timeout', 'artifact_mismatch', 'spawn_failed']).toContain(
      supervisor.getState().lastIssue?.code,
    );
  });

  it('reloads when the snapshot changes between config generation and spawn', async () => {
    setAfterWriteGeneratedConfigForTest(() => {
      const current = snapshotHolder.current;
      if (!current || current.revision !== 1) return;
      snapshotHolder.current = { ...current, revision: 2 };
    });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 4000 });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    // YAML was generated from revision 1; a newer snapshot must not be marked applied.
    expect(supervisor.getState().appliedRevision).toBe(1);
    const starts = readFileSync(startsFile, 'utf8').length;

    await supervisor.reconcile();
    await waitFor(() => supervisor.getState().appliedRevision === 2);
    expect(supervisor.getState().appliedRevision).toBe(2);
    expect(readFileSync(startsFile, 'utf8').length).toBe(starts);

    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 12_000);

  it('does not hot-loop when the engine has never started (heal cooldown)', async () => {
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '99' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 60_000,
      healBackoffMaxMs: 60_000,
      startWaitMs: 400,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    const startsAfterFirst = readFileSync(startsFile, 'utf8').length;
    expect(startsAfterFirst).toBeGreaterThan(0);
    await supervisor.reconcile();
    await supervisor.reconcile();
    expect(readFileSync(startsFile, 'utf8').length).toBe(startsAfterFirst);
    expect(supervisor.getState().state).toBe('error');
    expect(supervisor.getState().nextHealAt).toBeGreaterThan(Date.now());
  });

  it('heals from error after the cooldown without resetting crash counters', async () => {
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '3' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 1,
      healBackoffMaxMs: 1,
      startWaitMs: 1500,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(supervisor.getState().lastIssue).toBeNull();
    expect(supervisor.getState().healAttempts).toBe(0);
    expect(supervisor.getState().nextHealAt).toBeNull();
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 20_000);

  it('clears lastIssue on a desired stop', async () => {
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '99' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 60_000,
      startWaitMs: 400,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().lastIssue).toBeTruthy();
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.reconcile();
    expect(['stopped', 'not_installed', 'unsupported']).toContain(supervisor.getState().state);
    expect(supervisor.getState().lastIssue).toBeNull();
    expect(supervisor.getState().healAttempts).toBe(0);
  });

  it('records geodata_missing as informational while staying running', async () => {
    snapshotHolder.current = makeSnapshot({ ruleMode: 'smart' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({ startWaitMs: 4000 });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(supervisor.getState().lastIssue?.code).toBe('geodata_missing');
    const config = readFileSync(enginePaths(dataDir).configPath, 'utf8');
    expect(config).not.toContain('GEOSITE,cn,DIRECT');
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 12_000);

  it('admin restart() clears heal state', async () => {
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '99' });
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 60_000,
      startWaitMs: 400,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    expect(supervisor.getState().healAttempts).toBeGreaterThan(0);
    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
    expect(supervisor.getState().lastIssue).toBeNull();
    expect(supervisor.getState().healAttempts).toBe(0);
    expect(supervisor.getState().nextHealAt).toBeNull();
  });

  it('does not treat a failed generation-2 restart as a fresh bump (heal cooldown)', async () => {
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 60_000,
      healBackoffMaxMs: 60_000,
      startWaitMs: 1500,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(supervisor.getState().appliedEngineGeneration).toBe(1);
    const startsAfterGen1 = readFileSync(startsFile, 'utf8').length;

    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: '99' });
    const current = snapshotHolder.current!;
    snapshotHolder.current = { ...current, engineGeneration: 2 };

    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    expect(supervisor.getState().appliedEngineGeneration).toBe(1);
    const startsAfterFail = readFileSync(startsFile, 'utf8').length;
    expect(startsAfterFail).toBeGreaterThan(startsAfterGen1);

    await supervisor.reconcile();
    await supervisor.reconcile();
    expect(readFileSync(startsFile, 'utf8').length).toBe(startsAfterFail);
    expect(supervisor.getState().state).toBe('error');
    expect(supervisor.getState().nextHealAt).toBeGreaterThan(Date.now());

    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 20_000);

  it('heals a failed generation-2 start after the cooldown', async () => {
    const { EngineSupervisor } = await import('./supervisor');
    const supervisor = new EngineSupervisor({
      healBackoffBaseMs: 1,
      healBackoffMaxMs: 1,
      startWaitMs: 1500,
    });
    live.push(supervisor);
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );

    const startsAfterGen1 = readFileSync(startsFile, 'utf8').length;
    writeWrapper({ FAKE_ENGINE_SKIP_LISTEN: String(startsAfterGen1 + 3) });
    snapshotHolder.current = { ...snapshotHolder.current!, engineGeneration: 2 };

    await supervisor.reconcile();
    expect(supervisor.getState().state).toBe('error');
    const startsAfterFail = readFileSync(startsFile, 'utf8').length;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.reconcile();
    await waitFor(
      () => supervisor.getState().state === 'running' || supervisor.getState().state === 'degraded',
    );
    expect(readFileSync(startsFile, 'utf8').length).toBeGreaterThan(startsAfterFail);
    expect(supervisor.getState().appliedEngineGeneration).toBe(2);

    snapshotHolder.current = makeSnapshot({ masterEnabled: false });
    await supervisor.restart();
  }, 25_000);
});
