import { isIP } from 'node:net';

import { containsSensitiveMaterial, isCredentialBearingUrl, isSensitiveKey } from '../redaction';
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
  ResolvedAddress,
  SafeOutboundHttpClientOptions,
  SafeOutboundRequestInit,
  SafeOutboundResponse,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Credential headers that must not follow a cross-origin redirect. */
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
]);

export class SafeOutboundHttpClient {
  private readonly policyProvider: () => { policy: OutboundPolicy; version: number | string };
  private readonly resolve: DnsResolver;
  private readonly transport: PinnedTransport;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;

  constructor(options: SafeOutboundHttpClientOptions = {}) {
    const configuredPolicy = {
      allowlist: options.allowlist ?? DEFAULT_OUTBOUND_POLICY.allowlist,
      mode: options.mode ?? DEFAULT_OUTBOUND_POLICY.mode,
    };
    this.policyProvider =
      options.policyProvider ?? (() => ({ policy: configuredPolicy, version: 'static' }));
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
   * - cross-origin redirects strip Authorization/Cookie
   * - metadata endpoints never allowed
   * - maxResponseBytes enforced during stream read (not post-buffer trim)
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
    const deadlineAt = Date.now() + timeoutMs;

    let method = (init.method ?? 'GET').toUpperCase();
    let body = toBuffer(init.body);
    const baseHeaders: Record<string, string> = { ...init.headers };
    const secretBearing =
      init.secretBearing === true || hasSensitiveHeaders(baseHeaders) || hasSensitiveBody(body);

    // Drop hop-by-hop that we control
    delete baseHeaders.host;
    delete baseHeaders.Host;

    while (true) {
      this.assertUrlPolicy(current, this.getPolicy());

      const hostname = current.hostname;
      const addresses = await this.resolveHost(hostname, deadlineAt);
      this.assertResolvedAddresses(current, addresses, this.getPolicy());
      this.assertResolvedAddresses(current, addresses, this.getPolicy());

      // Pin to first allowed address (all were validated)
      const pinned = addresses[0]!;
      const remainingMs = this.remainingMs(deadlineAt);

      const response = await this.withDeadline(
        this.transport({
          body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
          family: pinned.family,
          headers: { ...baseHeaders },
          maxResponseBytes,
          method,
          pinnedAddress: pinned.address,
          timeoutMs: remainingMs,
          url: current,
        }),
        deadlineAt,
      );

      if (REDIRECT_STATUSES.has(response.status) && redirects < maxRedirects) {
        const location = headerGet(response.headers, 'location');
        if (!location) {
          return this.toResponse(response, current);
        }
        const previous = current;
        current = this.parseUrl(new URL(location, previous));
        redirects += 1;

        if (!isSameOrigin(previous, current)) {
          if (secretBearing) {
            throw ssrfBlocked('cross-origin redirect rejected for secret-bearing request');
          }
          stripCredentialHeaders(baseHeaders);
        }

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

      return this.toResponse(response, current);
    }
  };

  /** Policy check without performing a network request (admin URL validation). */
  assertAllowed = async (input: string | URL): Promise<void> => {
    const deadlineAt = Date.now() + this.timeoutMs;
    const url = this.parseUrl(input);
    this.assertUrlPolicy(url, this.getPolicy());
    const hostname = url.hostname;
    const addresses = await this.resolveHost(hostname, deadlineAt);
    this.assertResolvedAddresses(url, addresses, this.getPolicy());
  };

  private parseUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    } catch {
      throw ssrfBlocked('invalid URL');
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

  private assertUrlPolicy(url: URL, policy: OutboundPolicy): void {
    if (isCredentialBearingUrl(url.toString())) {
      throw ssrfBlocked('credential-bearing URL rejected');
    }
    assertHostnamePolicy(url.hostname, policy);
  }

  private async resolveHost(hostname: string, deadlineAt: number) {
    const host = hostname.replaceAll(/^\[|\]$/g, '');
    if (isIP(host)) {
      const family = (isIP(host) === 6 ? 6 : 4) as 4 | 6;
      return [{ address: host, family }];
    }

    const addresses = await this.withDeadline(this.resolve(host), deadlineAt);
    if (!addresses.length) {
      throw ssrfBlocked('DNS resolution returned no addresses', { hostname: host });
    }
    return addresses;
  }

  private assertResolvedAddresses(
    url: URL,
    addresses: ResolvedAddress[],
    policy: OutboundPolicy,
  ): void {
    this.assertUrlPolicy(url, policy);
    const hostnameAllowListed =
      policy.mode === 'allowlist' && isAllowlistedHostOrIp(url.hostname, policy.allowlist);
    for (const address of addresses) {
      assertResolvedIpAllowed(address.address, policy, hostnameAllowListed);
    }
  }

  private getPolicy(): OutboundPolicy {
    const snapshot = this.policyProvider();
    if (!snapshot || !snapshot.policy || snapshot.version === undefined) {
      throw ssrfBlocked('outbound policy snapshot unavailable');
    }
    return snapshot.policy;
  }

  private remainingMs(deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw ssrfBlocked('absolute deadline exceeded');
    return remaining;
  }

  private withDeadline = async <T>(operation: Promise<T>, deadlineAt: number): Promise<T> => {
    const remaining = this.remainingMs(deadlineAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(ssrfBlocked('absolute deadline exceeded')), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  private toResponse(
    raw: {
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
      status: number;
      statusText: string;
      truncated?: boolean;
    },
    url: URL,
  ): SafeOutboundResponse {
    // Transport already enforced maxResponseBytes; do not re-buffer/trim large bodies here.
    const body = raw.body;

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
      truncated: raw.truncated === true,
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

/** Same origin = scheme + host (hostname + port) match. */
export const isSameOrigin = (a: URL, b: URL): boolean =>
  a.protocol === b.protocol && a.host === b.host;

/** Strip credential headers in place (case-insensitive key match). */
export const stripCredentialHeaders = (headers: Record<string, string>): void => {
  for (const key of Object.keys(headers)) {
    if (
      CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()) ||
      isSensitiveKey(key) ||
      containsSensitiveMaterial(headers[key])
    ) {
      delete headers[key];
    }
  }
};

const hasSensitiveHeaders = (headers: Record<string, string>): boolean =>
  Object.entries(headers).some(
    ([key, value]) =>
      CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()) ||
      isSensitiveKey(key) ||
      containsSensitiveMaterial(value),
  );

const hasSensitiveBody = (body: Buffer | undefined): boolean => {
  if (!body || body.length === 0 || body.length > 64 * 1024) return false;
  return containsSensitiveMaterial(body.toString('utf8'));
};

/** Factory with G-07 defaults (private allowed, metadata blocked). */
export const createSafeOutboundHttpClient = (
  options?: SafeOutboundHttpClientOptions,
): SafeOutboundHttpClient => new SafeOutboundHttpClient(options);
