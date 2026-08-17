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

import type {
  NetworkProxyEngineState,
  NetworkProxySubscriptionIssueCode,
} from '@/const/platform/networkProxy';
import {
  isNetworkProxySubscriptionIssueCode,
  NETWORK_PROXY_DEFAULTS,
  NETWORK_PROXY_LIMITS,
} from '@/const/platform/networkProxy';
import {
  assertHostnamePolicy,
  assertIpPolicy,
  createSafeOutboundHttpClient,
  type OutboundPolicy,
} from '@/server/enterprise/security/outboundHttp';
import type { SubscriptionIssue } from '@/types/platform/networkProxy';

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

const HTTP_STATUS_RE = /subscription fetch failed \((\d{3})\)/;
const SHARE_LINK_RE = /^(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls):\/\//mu;
const CLASH_YAML_RE = /^\s*proxies\s*:/mu;

export const makeSubscriptionIssue = (
  code: NetworkProxySubscriptionIssueCode,
  error?: unknown,
): SubscriptionIssue => {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error !== undefined
          ? String(error)
          : null;
  const detail = raw ? redactSecrets(raw).slice(0, 200) : null;
  return { at: new Date().toISOString(), code, detail: detail || null };
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : '');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

/** Map a thrown fetch/parse failure to a persisted subscription issue code. */
export const resolveSubscriptionIssueCode = (error: unknown): NetworkProxySubscriptionIssueCode => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && isNetworkProxySubscriptionIssueCode(code)) return code;
  }
  const name = errorName(error);
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';

  const message = errorMessage(error);
  if (/payload exceeds|8 MiB cap|maxResponseBytes/i.test(message)) return 'payload_too_large';
  if (/redirect limit|too many redirects|redirect_limit/i.test(message)) return 'redirect_limit';
  if (/deadline exceeded|timed out|timeout/i.test(message)) return 'timeout';
  if (HTTP_STATUS_RE.test(message)) return 'http_status';
  if (message === OUTLET_UNAVAILABLE_FETCH_NOTE || /outlet unavailable/i.test(message)) {
    return 'outlet_unavailable_fetched_direct';
  }
  if (/no nodes|no available node/i.test(message)) return 'no_nodes';
  if (/parse|YAML|invalid subscription/i.test(message)) return 'parse_failed';
  if (/subscription fetch failed|fetch failed/i.test(message)) return 'fetch_failed';
  return 'unknown';
};

const issueFromError = (error: unknown): SubscriptionIssue => {
  const code = resolveSubscriptionIssueCode(error);
  if (code === 'http_status') {
    const status = errorMessage(error).match(HTTP_STATUS_RE)?.[1] ?? null;
    return makeSubscriptionIssue(code, status);
  }
  return makeSubscriptionIssue(code, error);
};

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
  if (response.truncated) {
    throw new Error('subscription payload exceeds the 8 MiB cap');
  }
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

/** After a successful HTTP fetch: empty / unparseable bodies become lastIssue failures. */
export const classifySubscriptionPayload = (
  body: string,
): { code: 'no_nodes' | 'parse_failed' | null; nodeCount: number | null } => {
  const nodeCount = countNodesInPayload(body);
  if (nodeCount && nodeCount > 0) return { code: null, nodeCount };
  if (!body.trim()) return { code: 'no_nodes', nodeCount: 0 };
  if (SHARE_LINK_RE.test(body) || CLASH_YAML_RE.test(body) || /^\s{0,2}-\s+name:/mu.test(body)) {
    return { code: 'no_nodes', nodeCount: 0 };
  }
  return { code: 'parse_failed', nodeCount: null };
};

const issueForFetchedSubscription = (fetched: {
  body: string;
  fallbackNote: string | null;
  nodeCount: number | null;
}): SubscriptionIssue | null => {
  const classified = classifySubscriptionPayload(fetched.body);
  if (classified.code) return makeSubscriptionIssue(classified.code);
  if (fetched.fallbackNote) {
    return makeSubscriptionIssue('outlet_unavailable_fetched_direct', fetched.fallbackNote);
  }
  return null;
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
            fetchedAt: new Date(now),
            lastIssue: issueForFetchedSubscription(fetched),
            nodeCount: fetched.nodeCount,
            traffic: fetched.traffic,
          });
        }
      }
      providerFiles.push({ path, subscriptionId: sub.id });
    } catch (error) {
      if (db) {
        await recordSubscriptionFetchResult(db, sub.id, {
          fetchedAt: new Date(now),
          lastIssue: issueFromError(error),
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
          fetchedAt: now,
          lastIssue: issueForFetchedSubscription(fetched),
          nodeCount: fetched.nodeCount,
          traffic: fetched.traffic,
        });
      }
    }
  } catch (error) {
    if (db) {
      await recordSubscriptionFetchResult(db, sub.id, {
        fetchedAt: now,
        lastIssue: issueFromError(error),
      });
    }
    throw error;
  }
};

export { providerNameOf };
