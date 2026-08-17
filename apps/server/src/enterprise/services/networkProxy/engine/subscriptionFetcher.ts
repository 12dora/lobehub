/**
 * Node-side subscription fetch.
 *
 * Residual: when `subscriptionUpdateViaOutlet` uses a static proxy we resolve the
 * target hostname locally (dns.lookup all + IP policy: metadata blocked, private
 * allowed) before CONNECT. The static proxy still re-resolves independently; that
 * is accepted for v1. Engine-outlet fetches rely on mihomo REJECT rules instead.
 */
import { promises as dns } from 'node:dns';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { fetch as undiciFetch, ProxyAgent } from 'undici';

import type { NetworkProxyEngineState } from '@/const/platform/networkProxy';
import { NETWORK_PROXY_DEFAULTS, NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import {
  assertHostnamePolicy,
  assertIpPolicy,
  createSafeOutboundHttpClient,
  type OutboundPolicy,
} from '@/server/enterprise/security/outboundHttp';

import type { NetworkProxyRuntimeSnapshot, SubscriptionRuntime } from './b1';
import {
  parseSubscriptionUserinfoHeader,
  recordSubscriptionFetchResult,
  redactSecrets,
  redactUrlForDisplay,
} from './b1';
import { providerFileName, providerNameOf } from './configGenerator';
import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { ensureSecureDirectory, removeIfPresent, writeFileAtomically } from './fsSecure';

const SAFE_ID = /^[\w-]+$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUBSCRIPTION_HOST_POLICY: OutboundPolicy = {
  allowlist: [],
  mode: 'allow-private',
};

export const OUTLET_UNAVAILABLE_FETCH_NOTE = 'outlet unavailable, fetched direct';

const providerPath = (providersDir: string, id: string): string => {
  if (!SAFE_ID.test(id)) {
    return throwNetworkProxyError(
      NETWORK_PROXY_ENGINE_ERROR_CODES.SUBSCRIPTION_INVALID,
      'subscription id is not a safe provider file name',
    );
  }
  return path.join(providersDir, providerFileName(id));
};

const isDue = (sub: SubscriptionRuntime, now: number): boolean => {
  if (!sub.lastUpdateAt) return true;
  if (sub.refreshRequestedAt && sub.lastUpdateAt < sub.refreshRequestedAt) return true;
  const intervalSec =
    sub.updateIntervalSec ?? NETWORK_PROXY_DEFAULTS.SUBSCRIPTION_UPDATE_INTERVAL_SEC;
  return now - sub.lastUpdateAt.getTime() >= intervalSec * 1000;
};

const writeProviderFile = async (
  providersDir: string,
  path: string,
  body: string,
): Promise<void> => {
  await writeFileAtomically({ contents: body, mode: 0o600, path, root: providersDir });
};

const readCappedBody = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('subscription payload exceeds the 8 MiB cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const headerOf = (headers: Headers, name: string): string | null => {
  const direct = headers.get(name);
  if (direct) return direct;
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
};

/** Engine proxy only when state is `running`; else static URL; never B3. */
export const resolveSubscriptionOutletProxy = (input: {
  engineProxyUrl?: string | null;
  engineState?: NetworkProxyEngineState | null;
  snapshot: NetworkProxyRuntimeSnapshot;
}): { fallbackNote: string | null; kind: 'engine' | 'static' | null; proxyUrl: string | null } => {
  if (!input.snapshot.config.subscriptionUpdateViaOutlet) {
    return { fallbackNote: null, kind: null, proxyUrl: null };
  }
  if (
    input.snapshot.config.outlet.kind === 'engine' &&
    input.engineState === 'running' &&
    input.engineProxyUrl
  ) {
    return { fallbackNote: null, kind: 'engine', proxyUrl: input.engineProxyUrl };
  }
  if (input.snapshot.config.outlet.kind === 'static' && input.snapshot.staticProxyUrl) {
    return { fallbackNote: null, kind: 'static', proxyUrl: input.snapshot.staticProxyUrl };
  }
  return { fallbackNote: OUTLET_UNAVAILABLE_FETCH_NOTE, kind: null, proxyUrl: null };
};

const assertResolvedAddressesAllowed = async (hostname: string): Promise<void> => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const answer of answers) {
    assertIpPolicy(answer.address, SUBSCRIPTION_HOST_POLICY);
  }
};

const assertSubscriptionUrl = (url: string): URL => {
  const parsed = new URL(url);
  assertHostnamePolicy(parsed.hostname, SUBSCRIPTION_HOST_POLICY);
  return parsed;
};

const fetchViaOutlet = async (
  url: string,
  proxyUrl: string,
  userAgent: string,
  checkResolvedIps: boolean,
): Promise<{ body: string; userinfo: string | null }> => {
  const agent = new ProxyAgent(proxyUrl);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    NETWORK_PROXY_LIMITS.SUBSCRIPTION_FETCH_TIMEOUT_MS,
  );
  try {
    let current = assertSubscriptionUrl(url);
    if (checkResolvedIps) await assertResolvedAddressesAllowed(current.hostname);
    for (let hops = 0; hops <= NETWORK_PROXY_LIMITS.SUBSCRIPTION_MAX_REDIRECTS; hops += 1) {
      const response = await undiciFetch(current, {
        dispatcher: agent,
        headers: { 'User-Agent': userAgent },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        if (hops >= NETWORK_PROXY_LIMITS.SUBSCRIPTION_MAX_REDIRECTS) {
          throw new Error('subscription fetch exceeded the redirect limit');
        }
        const location = response.headers.get('location');
        if (!location) throw new Error('subscription redirect missing Location');
        current = assertSubscriptionUrl(new URL(location, current).toString());
        if (checkResolvedIps) await assertResolvedAddressesAllowed(current.hostname);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `subscription fetch failed (${response.status}) from ${redactUrlForDisplay(current.toString())}`,
        );
      }
      const body = await readCappedBody(
        response as unknown as Response,
        NETWORK_PROXY_LIMITS.SUBSCRIPTION_MAX_BYTES,
      );
      return {
        body,
        userinfo: headerOf(response.headers as unknown as Headers, 'subscription-userinfo'),
      };
    }
    throw new Error('subscription fetch exceeded the redirect limit');
  } finally {
    clearTimeout(timer);
    await agent.close().catch(() => undefined);
  }
};

const fetchViaSafeOutbound = async (
  url: string,
  userAgent: string,
): Promise<{ body: string; userinfo: string | null }> => {
  assertSubscriptionUrl(url);
  const client = createSafeOutboundHttpClient({
    maxRedirects: NETWORK_PROXY_LIMITS.SUBSCRIPTION_MAX_REDIRECTS,
    maxResponseBytes: NETWORK_PROXY_LIMITS.SUBSCRIPTION_MAX_BYTES,
    mode: 'allow-private',
    timeoutMs: NETWORK_PROXY_LIMITS.SUBSCRIPTION_FETCH_TIMEOUT_MS,
  });
  const response = await client.fetch(url, {
    headers: { 'User-Agent': userAgent },
  });
  if (!response.ok) {
    throw new Error(
      `subscription fetch failed (${response.status}) from ${redactUrlForDisplay(url)}`,
    );
  }
  return {
    body: response.body.toString('utf8'),
    userinfo: headerOf(response.headers, 'subscription-userinfo'),
  };
};

const loadDb = async () => {
  try {
    const { getServerDB } = await import('@/database/core/db-adaptor');
    return await getServerDB();
  } catch {
    return null;
  }
};

const countNodesInPayload = (body: string): number | null => {
  const yamlNodes = body.match(/^\s{0,2}-\s+name:/gmu);
  if (yamlNodes && yamlNodes.length > 0) return yamlNodes.length;
  const links = body
    .split(/\r?\n/u)
    .filter((line) =>
      /^(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls):\/\//u.test(line.trim()),
    );
  return links.length > 0 ? links.length : null;
};

export const writeManualSubscriptionFile = async (
  providersDir: string,
  sub: SubscriptionRuntime,
): Promise<void> => {
  if (!sub.payload) return;
  await ensureSecureDirectory(providersDir, { create: true, root: providersDir });
  await writeProviderFile(providersDir, providerPath(providersDir, sub.id), sub.payload);
};

export const fetchUrlSubscription = async (input: {
  engineProxyUrl?: string | null;
  engineState?: NetworkProxyEngineState | null;
  providersDir: string;
  snapshot: NetworkProxyRuntimeSnapshot;
  sub: SubscriptionRuntime;
}): Promise<{
  body: string;
  fallbackNote: string | null;
  nodeCount: number | null;
  traffic: ReturnType<typeof parseSubscriptionUserinfoHeader>;
}> => {
  const url = input.sub.url;
  if (!url) {
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.SUBSCRIPTION_INVALID);
  }
  const userAgent = input.sub.userAgent ?? NETWORK_PROXY_DEFAULTS.SUBSCRIPTION_USER_AGENT;
  const outlet = resolveSubscriptionOutletProxy({
    engineProxyUrl: input.engineProxyUrl,
    engineState: input.engineState,
    snapshot: input.snapshot,
  });
  const fetched = outlet.proxyUrl
    ? await fetchViaOutlet(url, outlet.proxyUrl, userAgent, outlet.kind === 'static')
    : await fetchViaSafeOutbound(url, userAgent);
  await ensureSecureDirectory(input.providersDir, { create: true, root: input.providersDir });
  await writeProviderFile(
    input.providersDir,
    providerPath(input.providersDir, input.sub.id),
    fetched.body,
  );
  return {
    body: fetched.body,
    fallbackNote: outlet.fallbackNote,
    nodeCount: countNodesInPayload(fetched.body),
    traffic: parseSubscriptionUserinfoHeader(fetched.userinfo),
  };
};

export const removeOrphanProviderFiles = async (
  providersDir: string,
  liveIds: Set<string>,
): Promise<void> => {
  let entries: string[];
  try {
    entries = await readdir(providersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('sub_') && name.endsWith('.txt'))
      .map(async (name) => {
        const id = name.slice('sub_'.length, -'.txt'.length);
        if (!liveIds.has(id)) await removeIfPresent(path.join(providersDir, name));
      }),
  );
};

export const syncSubscriptionsFromSnapshot = async (input: {
  engineProxyUrl?: string | null;
  engineState?: NetworkProxyEngineState | null;
  providersDir: string;
  snapshot: NetworkProxyRuntimeSnapshot;
}): Promise<{ providerFiles: { path: string; subscriptionId: string }[] }> => {
  await ensureSecureDirectory(input.providersDir, { create: true, root: input.providersDir });
  const now = Date.now();
  const liveIds = new Set<string>();
  const providerFiles: { path: string; subscriptionId: string }[] = [];
  const db = await loadDb();

  for (const sub of input.snapshot.subscriptions) {
    if (!sub.enabled || !SAFE_ID.test(sub.id)) continue;
    liveIds.add(sub.id);
    const path = providerPath(input.providersDir, sub.id);
    try {
      if (sub.kind === 'manual') {
        await writeManualSubscriptionFile(input.providersDir, sub);
      } else if (sub.kind === 'url' && isDue(sub, now)) {
        const fetched = await fetchUrlSubscription({
          engineProxyUrl: input.engineProxyUrl,
          engineState: input.engineState,
          providersDir: input.providersDir,
          snapshot: input.snapshot,
          sub,
        });
        if (db) {
          await recordSubscriptionFetchResult(db, sub.id, {
            error: fetched.fallbackNote,
            fetchedAt: new Date(now),
            nodeCount: fetched.nodeCount,
            traffic: fetched.traffic,
          });
        }
      }
      providerFiles.push({ path, subscriptionId: sub.id });
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.message : 'subscription fetch failed',
      );
      if (db) {
        await recordSubscriptionFetchResult(db, sub.id, {
          error: message,
          fetchedAt: new Date(now),
        });
      }
    }
  }

  await removeOrphanProviderFiles(input.providersDir, liveIds);
  return { providerFiles };
};

export const refreshSubscriptionNow = async (input: {
  engineProxyUrl?: string | null;
  engineState?: NetworkProxyEngineState | null;
  id: string;
  providersDir: string;
  snapshot: NetworkProxyRuntimeSnapshot;
}): Promise<void> => {
  const found = input.snapshot.subscriptions.find((item) => item.id === input.id);
  if (!found) {
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.SUBSCRIPTION_INVALID);
  }
  const sub = found;
  const db = await loadDb();
  const now = new Date();
  try {
    if (sub.kind === 'manual') {
      await writeManualSubscriptionFile(input.providersDir, sub);
    } else {
      const fetched = await fetchUrlSubscription({
        engineProxyUrl: input.engineProxyUrl,
        engineState: input.engineState,
        providersDir: input.providersDir,
        snapshot: input.snapshot,
        sub,
      });
      if (db) {
        await recordSubscriptionFetchResult(db, sub.id, {
          error: fetched.fallbackNote,
          fetchedAt: now,
          nodeCount: fetched.nodeCount,
          traffic: fetched.traffic,
        });
      }
    }
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : 'subscription fetch failed',
    );
    if (db) {
      await recordSubscriptionFetchResult(db, sub.id, { error: message, fetchedAt: now });
    }
    throw error;
  }
};

export { providerNameOf };
