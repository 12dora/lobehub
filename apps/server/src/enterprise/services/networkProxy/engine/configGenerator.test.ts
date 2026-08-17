// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { NETWORK_PROXY_ENGINE_GROUP_NAME } from '@/const/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import type { NetworkProxyRuntimeSnapshot } from './b1';
import { generateEngineConfig } from './configGenerator';

const snapshotOf = (
  patch: Partial<NetworkProxyRuntimeSnapshot['config']> = {},
): NetworkProxyRuntimeSnapshot => ({
  config: { ...createDefaultNetworkProxyConfig(), ...patch },
  desiredArtifacts: {},
  engineGeneration: 0,
  loadedAt: Date.now(),
  revision: 1,
  staticProxyUrl: null,
  subscriptions: [
    {
      enabled: true,
      excludeFilter: 'expire',
      filter: 'hk',
      id: 'nps_aaa',
      kind: 'url',
      lastUpdateAt: null,
      name: 'primary',
      payload: null,
      refreshRequestedAt: null,
      sortOrder: 0,
      updateIntervalSec: 86_400,
      url: 'https://example.com/sub',
      userAgent: 'clash.meta',
    },
  ],
});

const generate = (snap: NetworkProxyRuntimeSnapshot, geodataReady: boolean) =>
  generateEngineConfig({
    controllerPort: 19_002,
    controllerSecret: 'controller-secret',
    geodataReady,
    listenerPassword: 'listener-secret',
    mixedPort: 19_001,
    providerFiles: [{ path: '/tmp/providers/sub_nps_aaa.txt', subscriptionId: 'nps_aaa' }],
    providersDir: '/tmp/providers',
    snapshot: snap,
  });

describe('generateEngineConfig', () => {
  it('emits the simple-mode YAML with REJECT rules and no geodata matches', () => {
    const yaml = generate(
      snapshotOf({
        ruleMode: 'simple',
        outlet: {
          ...createDefaultNetworkProxyConfig().outlet,
          mode: 'auto',
        },
      }),
      false,
    );
    const doc = parse(yaml) as Record<string, unknown>;

    expect(doc['mixed-port']).toBe(19_001);
    expect(doc['bind-address']).toBe('127.0.0.1');
    expect(doc['allow-lan']).toBe(false);
    expect(doc.authentication).toEqual(['aihub:listener-secret']);
    expect(doc['external-controller']).toBe('127.0.0.1:19002');
    expect(doc.secret).toBe('controller-secret');
    expect(doc['geodata-mode']).toBe(false);
    expect(doc['geo-auto-update']).toBe(false);
    expect(doc.dns).toEqual({ enable: false });
    expect(yaml).not.toMatch(/no-resolve/);
    expect(yaml).toContain('IP-CIDR,169.254.169.254/32,REJECT');
    expect(yaml).toContain('IP-CIDR,127.0.0.0/8,REJECT');
    expect(yaml).not.toContain('GEOSITE,cn,DIRECT');
    expect(yaml).not.toContain('GEOIP,CN,DIRECT');
    expect(yaml).toContain(`MATCH,${NETWORK_PROXY_ENGINE_GROUP_NAME}`);

    const providers = doc['proxy-providers'] as Record<string, { path: string; type: string }>;
    expect(providers.sub_nps_aaa.type).toBe('file');
    expect(providers.sub_nps_aaa.path).toBe('providers/sub_nps_aaa.txt');
    expect(providers.sub_nps_aaa).toMatchObject({ 'filter': 'hk', 'exclude-filter': 'expire' });
    expect(providers.sub_nps_aaa).toMatchObject({
      'health-check': expect.objectContaining({ interval: 300 }),
    });

    const groups = doc['proxy-groups'] as Array<{ name: string; type: string; use: string[] }>;
    expect(groups[0]).toMatchObject({
      name: NETWORK_PROXY_ENGINE_GROUP_NAME,
      type: 'url-test',
      use: ['sub_nps_aaa'],
    });
  });

  it('adds GEOSITE/GEOIP DIRECT and enables DNS only when smart + geodataReady', () => {
    const ready = generate(snapshotOf({ ruleMode: 'smart' }), true);
    const notReady = generate(snapshotOf({ ruleMode: 'smart' }), false);
    expect(ready).toContain('GEOSITE,cn,DIRECT');
    expect(ready).toContain('GEOIP,CN,DIRECT');
    expect(parse(ready)).toMatchObject({ dns: { enable: true, nameserver: ['system'] } });
    expect(notReady).not.toContain('GEOSITE,cn,DIRECT');
    expect(notReady).not.toContain('GEOIP,CN,DIRECT');
    expect(parse(notReady)).toMatchObject({ dns: { enable: false } });
  });

  it('maps manual outlet mode to a select group', () => {
    const yaml = generate(
      snapshotOf({
        outlet: { ...createDefaultNetworkProxyConfig().outlet, mode: 'manual' },
      }),
      false,
    );
    const doc = parse(yaml) as { 'proxy-groups': Array<{ type: string }> };
    expect(doc['proxy-groups'][0]?.type).toBe('select');
    expect(yaml).not.toContain('tolerance:');
  });
});
