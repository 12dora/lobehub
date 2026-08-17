// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import type { NetworkProxyRuntimeSnapshot, SubscriptionRuntime } from './b1';
import { parseSubscriptionUserinfoHeader } from './b1';
import {
  classifySubscriptionPayload,
  OUTLET_UNAVAILABLE_FETCH_NOTE,
  removeOrphanProviderFiles,
  resolveSubscriptionIssueCode,
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

describe('resolveSubscriptionIssueCode', () => {
  it('maps timeout and abort names to timeout', () => {
    expect(
      resolveSubscriptionIssueCode(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    ).toBe('timeout');
    expect(
      resolveSubscriptionIssueCode(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBe('timeout');
    expect(
      resolveSubscriptionIssueCode(new Error('Outbound request absolute deadline exceeded')),
    ).toBe('timeout');
  });

  it('maps HTTP status, payload, redirect, and generic fetch failures', () => {
    expect(
      resolveSubscriptionIssueCode(new Error('subscription fetch failed (502) from https://x')),
    ).toBe('http_status');
    expect(
      resolveSubscriptionIssueCode(new Error('subscription payload exceeds the 8 MiB cap')),
    ).toBe('payload_too_large');
    expect(
      resolveSubscriptionIssueCode(new Error('subscription fetch exceeded the redirect limit')),
    ).toBe('redirect_limit');
    expect(resolveSubscriptionIssueCode(new Error('SSRF blocked: too many redirects'))).toBe(
      'redirect_limit',
    );
    expect(resolveSubscriptionIssueCode(new Error('subscription fetch failed'))).toBe(
      'fetch_failed',
    );
    expect(resolveSubscriptionIssueCode(new Error('socket hang up'))).toBe('unknown');
  });

  it('maps the outlet fallback note and payload classifications', () => {
    expect(resolveSubscriptionIssueCode(new Error(OUTLET_UNAVAILABLE_FETCH_NOTE))).toBe(
      'outlet_unavailable_fetched_direct',
    );
    expect(classifySubscriptionPayload('')).toEqual({ code: 'no_nodes', nodeCount: 0 });
    expect(classifySubscriptionPayload('proxies:\n')).toEqual({ code: 'no_nodes', nodeCount: 0 });
    expect(classifySubscriptionPayload('not a subscription')).toEqual({
      code: 'parse_failed',
      nodeCount: null,
    });
    expect(classifySubscriptionPayload('- name: hk-1\n  type: ss\n')).toEqual({
      code: null,
      nodeCount: 1,
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
