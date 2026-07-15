import { isIP } from 'node:net';

import { ssrfBlocked } from './errors';
import {
  assertHostnamePolicy,
  assertResolvedIpAllowed,
  DEFAULT_OUTBOUND_POLICY,
  isAllowlistedHostOrIp,
  type OutboundPolicy,
} from './policy';
import { defaultDnsResolve, defaultPinnedTransport } from './transport';
import type {
  DnsResolver,
  PinnedTransport,
  SafeOutboundHttpClientOptions,
  SafeOutboundRequestInit,
  SafeOutboundResponse,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export class SafeOutboundHttpClient {
  private readonly policy: OutboundPolicy;
  private readonly resolve: DnsResolver;
  private readonly transport: PinnedTransport;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;

  constructor(options: SafeOutboundHttpClientOptions = {}) {
    this.policy = {
      allowlist: options.allowlist ?? DEFAULT_OUTBOUND_POLICY.allowlist,
      mode: options.mode ?? DEFAULT_OUTBOUND_POLICY.mode,
    };
    this.resolve = options.resolve ?? defaultDnsResolve;
    this.transport = options.transport ?? defaultPinnedTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * SSRF-safe outbound request.
   * - http/https only
   * - DNS resolve → policy check → pin connect
   * - each redirect re-validates host + resolved IPs
   * - metadata endpoints never allowed
   */
  fetch = async (
    input: string | URL,
    init: SafeOutboundRequestInit = {},
  ): Promise<SafeOutboundResponse> => {
    let current = this.parseUrl(input);
    let redirects = 0;
    const maxRedirects = init.maxRedirects ?? this.maxRedirects;
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const maxResponseBytes = init.maxResponseBytes ?? this.maxResponseBytes;

    let method = (init.method ?? 'GET').toUpperCase();
    let body = toBuffer(init.body);
    const baseHeaders = { ...init.headers };

    // Drop hop-by-hop that we control
    delete baseHeaders.host;
    delete baseHeaders.Host;

    while (true) {
      this.assertUrlPolicy(current);

      const hostname = current.hostname;
      const hostnameAllowListed =
        this.policy.mode === 'allowlist' && isAllowlistedHostOrIp(hostname, this.policy.allowlist);

      const addresses = await this.resolveHost(hostname);
      for (const addr of addresses) {
        assertResolvedIpAllowed(addr.address, this.policy, hostnameAllowListed);
      }

      // Pin to first allowed address (all were validated)
      const pinned = addresses[0]!;

      const response = await this.transport({
        body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        family: pinned.family,
        headers: baseHeaders,
        method,
        pinnedAddress: pinned.address,
        timeoutMs,
        url: current,
      });

      if (REDIRECT_STATUSES.has(response.status) && redirects < maxRedirects) {
        const location = headerGet(response.headers, 'location');
        if (!location) {
          return this.toResponse(response, current, maxResponseBytes);
        }
        current = this.parseUrl(new URL(location, current));
        redirects += 1;
        // RFC: 303 switches to GET; 301/302 historically do for browsers — we follow GET for 301/302/303
        if (response.status === 303 || response.status === 302 || response.status === 301) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      if (REDIRECT_STATUSES.has(response.status) && redirects >= maxRedirects) {
        throw ssrfBlocked('too many redirects', { maxRedirects, url: current.toString() });
      }

      return this.toResponse(response, current, maxResponseBytes);
    }
  };

  /** Policy check without performing a network request (admin URL validation). */
  assertAllowed = async (input: string | URL): Promise<void> => {
    const url = this.parseUrl(input);
    this.assertUrlPolicy(url);
    const hostname = url.hostname;
    const hostnameAllowListed =
      this.policy.mode === 'allowlist' && isAllowlistedHostOrIp(hostname, this.policy.allowlist);
    const addresses = await this.resolveHost(hostname);
    for (const addr of addresses) {
      assertResolvedIpAllowed(addr.address, this.policy, hostnameAllowListed);
    }
  };

  private parseUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    } catch {
      throw ssrfBlocked('invalid URL', { input: String(input) });
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw ssrfBlocked(`protocol not allowed: ${url.protocol}`, {
        protocol: url.protocol,
      });
    }
    if (!url.hostname) {
      throw ssrfBlocked('URL missing hostname');
    }
    return url;
  }

  private assertUrlPolicy(url: URL): void {
    assertHostnamePolicy(url.hostname, this.policy);
  }

  private async resolveHost(hostname: string) {
    const host = hostname.replaceAll(/^\[|\]$/g, '');
    if (isIP(host)) {
      const family = (isIP(host) === 6 ? 6 : 4) as 4 | 6;
      return [{ address: host, family }];
    }

    const addresses = await this.resolve(host);
    if (!addresses.length) {
      throw ssrfBlocked('DNS resolution returned no addresses', { hostname: host });
    }
    return addresses;
  }

  private toResponse(
    raw: {
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
      status: number;
      statusText: string;
    },
    url: URL,
    maxResponseBytes: number,
  ): SafeOutboundResponse {
    let body = raw.body;
    if (body.length > maxResponseBytes) {
      body = body.subarray(0, maxResponseBytes);
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(raw.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    return {
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      body,
      headers,
      json: async () => JSON.parse(body.toString('utf8')),
      ok: raw.status >= 200 && raw.status < 300,
      status: raw.status,
      statusText: raw.statusText,
      text: async () => body.toString('utf8'),
      url: url.toString(),
    };
  }
}

const toBuffer = (body: string | Buffer | Uint8Array | undefined): Buffer | undefined => {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body);
};

const headerGet = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
};

/** Factory with G-07 defaults (private allowed, metadata blocked). */
export const createSafeOutboundHttpClient = (
  options?: SafeOutboundHttpClientOptions,
): SafeOutboundHttpClient => new SafeOutboundHttpClient(options);
