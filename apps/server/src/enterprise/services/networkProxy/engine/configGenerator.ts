import { stringify } from 'yaml';

import {
  NETWORK_PROXY_DEFAULTS,
  NETWORK_PROXY_ENGINE_GROUP_NAME,
  NETWORK_PROXY_ENGINE_LISTENER_USER,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';

import type { NetworkProxyRuntimeSnapshot } from './b1';

const REJECT_RULES = [
  'IP-CIDR,169.254.169.254/32,REJECT',
  'IP-CIDR,127.0.0.0/8,REJECT',
  'IP-CIDR,10.0.0.0/8,REJECT',
  'IP-CIDR,172.16.0.0/12,REJECT',
  'IP-CIDR,192.168.0.0/16,REJECT',
  'IP-CIDR,169.254.0.0/16,REJECT',
  'IP-CIDR6,::1/128,REJECT',
  'IP-CIDR6,fc00::/7,REJECT',
  'IP-CIDR6,fe80::/10,REJECT',
] as const;

const SMART_DIRECT_RULES = ['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT'] as const;

const outletGroupType = (mode: NetworkProxyRuntimeSnapshot['config']['outlet']['mode']) => {
  if (mode === 'manual') return 'select';
  if (mode === 'fallback') return 'fallback';
  return 'url-test';
};

const providerNameOf = (subscriptionId: string): string => `sub_${subscriptionId}`;

const relativeProviderPath = (subscriptionId: string): string =>
  `providers/${providerNameOf(subscriptionId)}.txt`;

export const generateEngineConfig = (input: {
  controllerPort: number;
  controllerSecret: string;
  geodataReady: boolean;
  listenerPassword: string;
  mixedPort: number;
  providerFiles: { path: string; subscriptionId: string }[];
  providersDir: string;
  snapshot: NetworkProxyRuntimeSnapshot;
}): string => {
  const { snapshot } = input;
  const smart = snapshot.config.ruleMode === 'smart' && input.geodataReady;
  const subscriptionsById = new Map(snapshot.subscriptions.map((item) => [item.id, item]));
  const providerNames: string[] = [];
  const providers: Record<string, Record<string, unknown>> = {};

  for (const file of input.providerFiles) {
    const name = providerNameOf(file.subscriptionId);
    providerNames.push(name);
    const sub = subscriptionsById.get(file.subscriptionId);
    const provider: Record<string, unknown> = {
      'health-check': {
        enable: true,
        interval: NETWORK_PROXY_DEFAULTS.LATENCY_INTERVAL_SEC,
        lazy: false,
        timeout: NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS,
        url: snapshot.config.outlet.latencyTestUrl,
      },
      'path': relativeProviderPath(file.subscriptionId),
      'type': 'file',
    };
    if (sub?.filter) provider.filter = sub.filter;
    if (sub?.excludeFilter) provider['exclude-filter'] = sub.excludeFilter;
    providers[name] = provider;
  }

  const group: Record<string, unknown> = {
    name: NETWORK_PROXY_ENGINE_GROUP_NAME,
    type: outletGroupType(snapshot.config.outlet.mode),
    use: providerNames,
  };
  if (snapshot.config.outlet.mode !== 'manual') {
    group.interval = snapshot.config.outlet.latencyIntervalSec;
    group.tolerance = snapshot.config.outlet.toleranceMs;
    group.url = snapshot.config.outlet.latencyTestUrl;
  }

  const rules: string[] = [...REJECT_RULES];
  if (smart) rules.push(...SMART_DIRECT_RULES);
  rules.push(`MATCH,${NETWORK_PROXY_ENGINE_GROUP_NAME}`);

  const doc: Record<string, unknown> = {
    'allow-lan': false,
    'authentication': [`${NETWORK_PROXY_ENGINE_LISTENER_USER}:${input.listenerPassword}`],
    'bind-address': '127.0.0.1',
    'dns': smart ? { enable: true, nameserver: ['system'] } : { enable: false },
    'external-controller': `127.0.0.1:${input.controllerPort}`,
    'geo-auto-update': false,
    'geodata-mode': false,
    'log-level': snapshot.config.engineLogLevel,
    'mixed-port': input.mixedPort,
    'mode': 'rule',
    'profile': { 'store-fake-ip': false, 'store-selected': false },
    'proxy-groups': [group],
    'proxy-providers': providers,
    rules,
    'secret': input.controllerSecret,
    'tcp-concurrent': true,
    'unified-delay': true,
  };

  return stringify(doc, { indent: 2, lineWidth: 0 });
};

export const providerFileName = (subscriptionId: string): string =>
  `${providerNameOf(subscriptionId)}.txt`;

export { providerNameOf };
