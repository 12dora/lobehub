// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import type { NetworkProxyRuntimeSnapshot, SubscriptionRuntime } from './b1';
import { parseSubscriptionUserinfoHeader } from './b1';
import {
  OUTLET_UNAVAILABLE_FETCH_NOTE,
  removeOrphanProviderFiles,
  resolveSubscriptionOutletProxy,
  writeManualSubscriptionFile,
} from './subscriptionFetcher';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'np-sub-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { force: true, recursive: true });
});

const manualSub = (id: string, payload: string): SubscriptionRuntime => ({
  enabled: true,
  excludeFilter: null,
  filter: null,
  id,
  kind: 'manual',
  lastUpdateAt: null,
  name: id,
  payload,
  refreshRequestedAt: null,
  sortOrder: 0,
  updateIntervalSec: null,
  url: null,
  userAgent: null,
});

describe('parseSubscriptionUserinfoHeader', () => {
  it('parses upload/download/total/expire', () => {
    const traffic = parseSubscriptionUserinfoHeader(
      'upload=1; download=2; total=3; expire=1700000000',
    );
    expect(traffic).toEqual({
      download: 2,
      expireAt: new Date(1_700_000_000 * 1000).toISOString(),
      total: 3,
      upload: 1,
    });
  });
});

describe('subscription provider files', () => {
  it('writes a manual payload and removes files for deleted subscriptions', async () => {
    await writeManualSubscriptionFile(dir, manualSub('nps_keep', 'ss://keep'));
    writeFileSync(path.join(dir, 'sub_nps_gone.txt'), 'ss://gone');
    await removeOrphanProviderFiles(dir, new Set(['nps_keep']));
    expect(readFileSync(path.join(dir, 'sub_nps_keep.txt'), 'utf8')).toBe('ss://keep');
    expect(() => readFileSync(path.join(dir, 'sub_nps_gone.txt'))).toThrow();
  });
});

describe('resolveSubscriptionOutletProxy', () => {
  const base = (): NetworkProxyRuntimeSnapshot => ({
    config: createDefaultNetworkProxyConfig(),
    desiredArtifacts: {},
    engineGeneration: 0,
    loadedAt: Date.now(),
    revision: 0,
    staticProxyUrl: 'http://static.example:8080',
    subscriptions: [],
  });

  it('uses the running engine proxy URL when the outlet is the engine', () => {
    const snapshot = base();
    snapshot.config.subscriptionUpdateViaOutlet = true;
    snapshot.config.outlet.kind = 'engine';
    expect(
      resolveSubscriptionOutletProxy({
        engineProxyUrl: 'http://aihub:x@127.0.0.1:9',
        engineState: 'running',
        snapshot,
      }),
    ).toEqual({ fallbackNote: null, kind: 'engine', proxyUrl: 'http://aihub:x@127.0.0.1:9' });
    expect(
      resolveSubscriptionOutletProxy({
        engineProxyUrl: 'http://aihub:x@127.0.0.1:9',
        engineState: 'degraded',
        snapshot,
      }),
    ).toEqual({ fallbackNote: OUTLET_UNAVAILABLE_FETCH_NOTE, kind: null, proxyUrl: null });
  });

  it('uses the static proxy URL when the outlet is static', () => {
    const snapshot = base();
    snapshot.config.subscriptionUpdateViaOutlet = true;
    snapshot.config.outlet.kind = 'static';
    expect(resolveSubscriptionOutletProxy({ engineProxyUrl: null, snapshot })).toEqual({
      fallbackNote: null,
      kind: 'static',
      proxyUrl: 'http://static.example:8080',
    });
  });

  it('falls back to direct with a recorded note when the outlet is down', () => {
    const snapshot = base();
    snapshot.config.subscriptionUpdateViaOutlet = true;
    snapshot.config.outlet.kind = 'engine';
    expect(resolveSubscriptionOutletProxy({ engineProxyUrl: null, snapshot })).toEqual({
      fallbackNote: OUTLET_UNAVAILABLE_FETCH_NOTE,
      kind: null,
      proxyUrl: null,
    });
  });
});

describe('NetworkProxyRuntimeSnapshot shape', () => {
  it('accepts a default config snapshot used by the fetcher', () => {
    const snapshot: NetworkProxyRuntimeSnapshot = {
      config: createDefaultNetworkProxyConfig(),
      desiredArtifacts: {},
      engineGeneration: 0,
      loadedAt: Date.now(),
      revision: 0,
      staticProxyUrl: null,
      subscriptions: [],
    };
    expect(snapshot.config.masterEnabled).toBe(false);
  });
});
