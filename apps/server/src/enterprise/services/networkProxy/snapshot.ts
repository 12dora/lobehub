import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { EnterpriseCacheDomain } from '@lobechat/observability-otel/modules/enterprise-platform';

import {
  NETWORK_PROXY_INVALIDATION_SCOPE,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';
import { getServerDB } from '@/database/core/db-adaptor';
import { NetworkProxySettingsModel } from '@/database/models/platform/networkProxySettings';
import type { NetworkProxySubscriptionRow } from '@/database/models/platform/networkProxySubscription';
import { NetworkProxySubscriptionModel } from '@/database/models/platform/networkProxySubscription';
import type {
  DesiredArtifacts,
  NetworkProxyConfig,
  NetworkProxySubscriptionKind,
  StaticProxyPersisted,
} from '@/types/platform/networkProxy';
import {
  createDefaultNetworkProxyConfig,
  normalizeNetworkProxyConfig,
} from '@/types/platform/networkProxy';

import { DomainConfigCache, invalidateDomainConfigCacheNamespace } from '../../runtimeConfig';
import {
  getPlatformConfigInvalidationPublisher,
  getPlatformConfigScopeVersion,
} from '../platformConfigInvalidation';
import { NETWORK_PROXY_SETTINGS_ID } from './constants';
import { openNetworkProxySecret } from './secrets';

export interface SubscriptionRuntime {
  enabled: boolean;
  excludeFilter: string | null;
  filter: string | null;
  id: string;
  kind: NetworkProxySubscriptionKind;
  lastUpdateAt: Date | null;
  name: string;
  payload: string | null;
  refreshRequestedAt: Date | null;
  sortOrder: number;
  updateIntervalSec: number | null;
  url: string | null;
  userAgent: string | null;
}

export interface NetworkProxyRuntimeSnapshot {
  config: NetworkProxyConfig;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  loadedAt: number;
  revision: number;
  staticProxyUrl: string | null;
  subscriptions: SubscriptionRuntime[];
}

const CACHE_NAMESPACE = 'network_proxy';
const CACHE_ID = 'settings';
const cacheKey = {};
/** Observability enum has no `network_proxy` member yet; cast until B6 adds it. */
const OBSERVABILITY_DOMAIN = 'network_proxy' as EnterpriseCacheDomain;

const digestSubscriptions = (rows: NetworkProxySubscriptionRow[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        rows.map((row) => ({
          enabled: row.enabled,
          excludeFilter: row.excludeFilter,
          filter: row.filter,
          id: row.id,
          kind: row.kind,
          lastUpdateAt: row.lastUpdateAt?.toISOString() ?? null,
          name: row.name,
          payloadCiphertext: row.payloadCiphertext,
          refreshRequestedAt: row.refreshRequestedAt?.toISOString() ?? null,
          sortOrder: row.sortOrder,
          updateIntervalSec: row.updateIntervalSec,
          updatedAt: row.updatedAt.toISOString(),
          urlCiphertext: row.urlCiphertext,
          urlHost: row.urlHost,
          userAgent: row.userAgent,
        })),
      ),
    )
    .digest('hex');

const changeKeyOf = (snapshot: NetworkProxyRuntimeSnapshot, subscriptionDigest: string): string =>
  [
    snapshot.revision,
    snapshot.engineGeneration,
    JSON.stringify(snapshot.desiredArtifacts),
    subscriptionDigest,
  ].join('|');

/**
 * RFC1123 hostname: labels `[A-Za-z0-9-]{1,63}`, no leading/trailing `-`,
 * total length ≤ 253. Empty labels (`..`) are rejected.
 */
const isRfc1123Hostname = (value: string): boolean => {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i.test(label),
  );
};

/**
 * Hostname (RFC1123) or IP literal. IPv6 is always bracketed. Rejects
 * `@ / ? # % \\` whitespace, `host:port`, and any other non-DNS label.
 */
export const formatStaticProxyHost = (server: string): string | null => {
  const trimmed = server.trim();
  if (!trimmed) return null;

  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;

  if (isIP(unbracketed) === 6) return `[${unbracketed}]`;
  if (trimmed !== unbracketed) return null;
  if (isIP(trimmed) === 4) return trimmed;
  if (isRfc1123Hostname(trimmed)) return trimmed;
  return null;
};

const buildStaticProxyUrl = async (
  proxy: StaticProxyPersisted | undefined,
): Promise<string | null> => {
  if (!proxy) return null;
  const host = formatStaticProxyHost(proxy.server);
  if (!host) return null;
  let password: string | undefined;
  if (proxy.passwordCiphertext) {
    try {
      password = await openNetworkProxySecret(proxy.passwordCiphertext);
    } catch {
      password = undefined;
    }
  }
  const hasAuth = Boolean(proxy.username) || Boolean(password);
  const userinfo = hasAuth
    ? `${encodeURIComponent(proxy.username ?? '')}:${encodeURIComponent(password ?? '')}@`
    : '';
  return `${proxy.type}://${userinfo}${host}:${proxy.port}`;
};

const openSecretOrNull = async (ciphertext: string | null): Promise<string | null> => {
  if (!ciphertext) return null;
  try {
    return await openNetworkProxySecret(ciphertext);
  } catch {
    return null;
  }
};

const toRuntimeSubscription = async (
  row: NetworkProxySubscriptionRow,
): Promise<SubscriptionRuntime> => ({
  enabled: row.enabled,
  excludeFilter: row.excludeFilter,
  filter: row.filter,
  id: row.id,
  kind: row.kind,
  lastUpdateAt: row.lastUpdateAt,
  name: row.name,
  payload: await openSecretOrNull(row.payloadCiphertext),
  refreshRequestedAt: row.refreshRequestedAt,
  sortOrder: row.sortOrder,
  updateIntervalSec: row.updateIntervalSec,
  url: await openSecretOrNull(row.urlCiphertext),
  userAgent: row.userAgent,
});

const defaultSnapshot = (): NetworkProxyRuntimeSnapshot => ({
  config: createDefaultNetworkProxyConfig(),
  desiredArtifacts: {},
  engineGeneration: 0,
  loadedAt: Date.now(),
  revision: 0,
  staticProxyUrl: null,
  subscriptions: [],
});

const cloneSnapshot = (snapshot: NetworkProxyRuntimeSnapshot): NetworkProxyRuntimeSnapshot =>
  structuredClone(snapshot);

type ChangeListener = (snap: NetworkProxyRuntimeSnapshot) => void;

let cache: DomainConfigCache<NetworkProxyRuntimeSnapshot> | null = null;
let lastLoaded: NetworkProxyRuntimeSnapshot | null = null;
let lastChangeKey: string | null = null;
let lastSubscriptionDigest = '';
const listeners = new Set<ChangeListener>();

const notifyIfChanged = (snapshot: NetworkProxyRuntimeSnapshot, subscriptionDigest: string) => {
  const key = changeKeyOf(snapshot, subscriptionDigest);
  if (key === lastChangeKey) return;
  lastChangeKey = key;
  lastSubscriptionDigest = subscriptionDigest;
  for (const listener of listeners) {
    try {
      listener(cloneSnapshot(snapshot));
    } catch (error) {
      console.error('[network-proxy] snapshot change listener failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
};

const remember = (snapshot: NetworkProxyRuntimeSnapshot, subscriptionDigest: string) => {
  lastLoaded = snapshot;
  notifyIfChanged(snapshot, subscriptionDigest);
};

const loadSnapshot = async (): Promise<NetworkProxyRuntimeSnapshot> => {
  const db = await getServerDB();
  const settings = await new NetworkProxySettingsModel(db).ensureDefault();
  const rows = await new NetworkProxySubscriptionModel(db).list();
  const config = normalizeNetworkProxyConfig(settings.config);
  const snapshot: NetworkProxyRuntimeSnapshot = {
    config,
    desiredArtifacts: settings.desiredArtifacts,
    engineGeneration: settings.engineGeneration,
    loadedAt: Date.now(),
    revision: settings.revision,
    staticProxyUrl: await buildStaticProxyUrl(config.staticProxy),
    subscriptions: await Promise.all(rows.map((row) => toRuntimeSubscription(row))),
  };
  remember(snapshot, digestSubscriptions(rows));
  return snapshot;
};

const cacheFor = (): DomainConfigCache<NetworkProxyRuntimeSnapshot> => {
  if (cache) return cache;
  cache = new DomainConfigCache<NetworkProxyRuntimeSnapshot>({
    cacheId: CACHE_ID,
    cacheKey,
    cacheTtlMs: NETWORK_PROXY_LIMITS.SETTINGS_SNAPSHOT_TTL_MS,
    cloneValue: cloneSnapshot,
    getScopeEpoch: () => getPlatformConfigScopeVersion(NETWORK_PROXY_INVALIDATION_SCOPE),
    load: async () => {
      try {
        return await loadSnapshot();
      } catch (error) {
        console.error('[network-proxy] settings load failed; serving last-known-good or default', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
        const fallback = lastLoaded ?? defaultSnapshot();
        remember(fallback, lastSubscriptionDigest);
        return fallback;
      }
    },
    namespace: CACHE_NAMESPACE,
    observabilityDomain: OBSERVABILITY_DOMAIN,
    onEntryStored: (value) => {
      if (value) lastLoaded = value;
    },
  });
  return cache;
};

export const getNetworkProxySnapshot = async (): Promise<NetworkProxyRuntimeSnapshot> => {
  try {
    const snapshot = await cacheFor().get();
    const resolved = snapshot ?? lastLoaded ?? defaultSnapshot();
    lastLoaded = resolved;
    return cloneSnapshot(resolved);
  } catch (error) {
    console.error('[network-proxy] settings cache failed; serving last-known-good or default', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    const fallback = lastLoaded ?? defaultSnapshot();
    lastLoaded = fallback;
    return cloneSnapshot(fallback);
  }
};

export const peekNetworkProxySnapshot = (): NetworkProxyRuntimeSnapshot | null =>
  lastLoaded ? cloneSnapshot(lastLoaded) : null;

export const invalidateNetworkProxySnapshot = (): void => {
  cache?.invalidate();
  invalidateDomainConfigCacheNamespace(CACHE_NAMESPACE);
};

export const publishNetworkProxyInvalidation = async (revision: number): Promise<void> => {
  await getPlatformConfigInvalidationPublisher().publish({
    at: new Date().toISOString(),
    resourceId: NETWORK_PROXY_SETTINGS_ID,
    resourceType: 'network_proxy',
    revision,
    scopes: [NETWORK_PROXY_INVALIDATION_SCOPE],
  });
  invalidateNetworkProxySnapshot();
};

export const onNetworkProxySnapshotChange = (
  listener: (snap: NetworkProxyRuntimeSnapshot) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const resetNetworkProxySnapshotForTest = (): void => {
  cache = null;
  lastLoaded = null;
  lastChangeKey = null;
  lastSubscriptionDigest = '';
  listeners.clear();
};
