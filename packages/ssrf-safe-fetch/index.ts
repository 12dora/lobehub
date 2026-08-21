/**
 * SSRF-safe fetch for server-side use.
 *
 * Default path: `request-filtering-agent` (blocks private / metadata IPs).
 *
 * Proxy path: when an enterprise network-proxy egress scope is active for the
 * current async context, this package reads
 * `Symbol.for('aihub.networkProxy.egressBinding')` which holds
 * `{ getProxyUrlFor(url: string): string | null }` (throws on fail-mode).
 * If that returns a proxy URL, the request uses `https-proxy-agent` /
 * `socks-proxy-agent` instead of the filtering agent, following redirects
 * manually (`redirect: 'manual'`).
 *
 * Redirect policy (design §3.5):
 * - The **first** hop's proxy URL is kept for the **whole** chain.
 * - Per-hop we only re-run hostname / metadata policy.
 * - A later hop that would be a bypass / APP_URL / infra host does **not**
 *   switch the chain to direct — it stays on the first proxy.
 * This package must not import enterprise code — the binding is the only seam.
 */
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import type { RequestFilteringAgentOptions } from 'request-filtering-agent';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const EGRESS_BINDING = Symbol.for('aihub.networkProxy.egressBinding');

const DEFAULT_MAX_REDIRECTS = 20;

const METADATA_HOSTNAMES = new Set([
  'instance-data',
  'metadata.goog',
  'metadata.google.internal',
  'metadata.tencentyun.com',
]);

const PROXY_UNAVAILABLE = 'PLATFORM_NETWORK_PROXY_UNAVAILABLE';

const isProxyUnavailable = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { errorType?: unknown; name?: unknown };
  return e.errorType === PROXY_UNAVAILABLE || e.name === 'NetworkProxyUnavailableError';
};

const expandIpv6 = (raw: string): string | null => {
  const host = raw.replaceAll(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const mid = Array.from({ length: Math.max(0, 8 - head.length - tail.length) }, () => '0');
  const groups = [...head, ...mid, ...tail].slice(0, 8);
  if (groups.length !== 8) return null;
  return groups.map((g) => (g || '0').padStart(4, '0')).join(':');
};

const mappedIpv4 = (host: string): string | null => {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1]!;
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
};

const isLinkLocalV4 = (ip: string): boolean => {
  const parts = ip.split('.').map((p) => Number(p));
  return parts.length === 4 && parts[0] === 169 && parts[1] === 254;
};

const isMetadataTarget = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
    if (METADATA_HOSTNAMES.has(host)) return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    const v4 = mappedIpv4(host) ?? (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : null);
    if (v4 === '100.100.100.200') return true;
    if (v4 && isLinkLocalV4(v4)) return true;
    const expanded = expandIpv6(host);
    if (expanded === expandIpv6('fd00:ec2::254')) return true;
    if (expanded === expandIpv6('::1')) return true;
    return false;
  } catch {
    return false;
  }
};

type EgressBinding = {
  getProxyUrlFor?: (target: string) => string | null;
  recordProxiedConnectFailure?: (proxyUrl: string, error?: unknown) => void;
  recordProxiedConnectSuccess?: (proxyUrl: string) => void;
};

const getBinding = (): EgressBinding | undefined =>
  (globalThis as typeof globalThis & { [EGRESS_BINDING]?: EgressBinding })[EGRESS_BINDING];

const createProxyAgent = (proxyUrl: string) => {
  const protocol = (() => {
    try {
      return new URL(proxyUrl).protocol;
    } catch {
      return '';
    }
  })();
  if (protocol === 'socks5:' || protocol === 'socks:' || proxyUrl.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
};

/**
 * Options for per-call SSRF configuration overrides
 */
export interface SSRFOptions {
  /** List of IP addresses to allow */
  allowIPAddressList?: string[];
  /** Whether to allow private/local IP addresses */
  allowPrivateIPAddress?: boolean;
  /**
   * Maximum response body size in bytes. When set, the body is consumed
   * incrementally and reading stops as soon as the cap is reached. The returned
   * Response contains only the bytes received up to that point (soft truncation —
   * still considered a successful response).
   *
   * Use this for any fetch that downloads untrusted content (e.g. web crawlers)
   * to prevent unbounded buffering of large or malicious responses from blowing
   * up serverless function memory.
   */
  maxContentLength?: number;
  /** Max redirect hops on the proxied path (default 20, node-fetch's default). */
  maxRedirects?: number;
  /**
   * Do not console.error the underlying fetch error (node-fetch embeds the
   * full request URL, including presigned query credentials). Thrown errors
   * are host-only.
   */
  redactErrors?: boolean;
}

/**
 * Consume a node-fetch Response body up to `cap` bytes, then stop. Breaking out
 * of `for await` closes the async iterator, which destroys the underlying stream
 * and releases the HTTP connection.
 */
const readBodyWithCap = async (
  body: NodeJS.ReadableStream | null,
  cap: number,
): Promise<Uint8Array> => {
  if (!body) return new Uint8Array(0);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = cap - total;
    if (buf.length >= remaining) {
      chunks.push(buf.subarray(0, remaining));
      total = cap;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }

  return Buffer.concat(chunks, total);
};

const toStandardResponse = async (
  response: {
    arrayBuffer: () => Promise<ArrayBuffer>;
    body?: unknown;
    headers: unknown;
    status: number;
    statusText: string;
  },
  cap?: number,
): Promise<Response> => {
  const body: BodyInit =
    cap && cap > 0
      ? ((await readBodyWithCap(response.body as NodeJS.ReadableStream | null, cap)) as any)
      : await response.arrayBuffer();
  return new Response(body, {
    headers: response.headers as any,
    status: response.status,
    statusText: response.statusText,
  });
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * SSRF-safe fetch implementation for server-side use
 * Uses request-filtering-agent to prevent requests to private IP addresses
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @param ssrfOptions - Optional per-call SSRF configuration overrides
 * @see https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address
 */
export const ssrfSafeFetch = async (
  url: string,

  options?: RequestInit,
  ssrfOptions?: SSRFOptions,
): Promise<Response> => {
  try {
    const envAllowPrivate = process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS === '1';
    const allowPrivate = ssrfOptions?.allowPrivateIPAddress ?? envAllowPrivate;

    const agentOptions: RequestFilteringAgentOptions = {
      allowIPAddressList:
        ssrfOptions?.allowIPAddressList ??
        process.env.SSRF_ALLOW_IP_ADDRESS_LIST?.split(',').filter(Boolean) ??
        [],
      allowMetaIPAddress: allowPrivate,
      allowPrivateIPAddress: allowPrivate,
      denyIPAddressList: [],
    };

    const binding = getBinding();
    const firstProxy = binding?.getProxyUrlFor ? binding.getProxyUrlFor(url) : null;
    const cap = ssrfOptions?.maxContentLength;

    if (!firstProxy) {
      const httpAgent = new RequestFilteringHttpAgent(agentOptions);
      const httpsAgent = new RequestFilteringHttpsAgent(agentOptions);
      const response = await fetch(url, {
        ...options,
        agent: (parsedURL: URL) => (parsedURL.protocol === 'https:' ? httpsAgent : httpAgent),
      } as any);
      return toStandardResponse(response, cap);
    }

    const maxRedirects = ssrfOptions?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let current = url;
    let method = (options?.method ?? 'GET').toUpperCase();
    let body = options?.body;

    // Keep the FIRST decision's proxy for the whole chain. Per-hop we only
    // re-check hostname policy (metadata). A later bypass host must not flip
    // the chain to direct — that would violate "all redirects through the proxy".
    const chainProxy = firstProxy;
    const proxyAgent = createProxyAgent(chainProxy);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (isMetadataTarget(current)) {
        throw new Error('SSRF blocked: cloud metadata hostname/IP is not allowed');
      }
      // Intentionally do not re-run getProxyUrlFor(current): a bypass / APP_URL
      // / infra host on a later hop stays on `chainProxy`.
      let response;
      try {
        response = await fetch(current, {
          ...options,
          agent: proxyAgent,
          body,
          method,
          redirect: 'manual',
        } as any);
      } catch (error) {
        binding?.recordProxiedConnectFailure?.(chainProxy, error);
        throw error;
      }
      // https-proxy-agent surfaces a failed CONNECT (e.g. 407) as a response.
      // That is a connect-phase failure, not a successful proxied hop.
      if (response.status === 407) {
        binding?.recordProxiedConnectFailure?.(
          chainProxy,
          Object.assign(new Error('Proxy authentication required'), { status: 407 }),
        );
      } else {
        binding?.recordProxiedConnectSuccess?.(chainProxy);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = (response.headers as { get?: (name: string) => string | null }).get?.(
          'location',
        );
        if (!location) return toStandardResponse(response, cap);
        current = new URL(location, current).href;
        if (response.status === 301 || response.status === 302 || response.status === 303) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      return toStandardResponse(response, cap);
    }

    throw new Error(`SSRF blocked: too many redirects (max ${maxRedirects})`);
  } catch (error) {
    if (isProxyUnavailable(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isSSRFBlock = errorMessage.includes('is not allowed');
    const host = redactHost(url);

    if (ssrfOptions?.redactErrors) {
      if (isSSRFBlock) {
        throw new Error(`SSRF blocked: host=${host}`, { cause: error });
      }
      throw new Error(`Fetch failed: host=${host}`, { cause: error });
    }

    if (isSSRFBlock) {
      console.error('SSRF protection blocked request:', error);
      throw new Error(
        `SSRF blocked: ${errorMessage}. ` +
          'See: https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address',
        { cause: error },
      );
    }

    console.error('Fetch error:', error);
    throw new Error(`Fetch failed: ${errorMessage}`, { cause: error });
  }
};

const redactHost = (value: string): string => {
  try {
    return new URL(value).host;
  } catch {
    return '<unparseable url>';
  }
};
