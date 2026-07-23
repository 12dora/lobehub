import { isIP } from 'node:net';

import { containsSensitiveMaterial, isCredentialBearingUrl, isSensitiveKey } from '../redaction';
import { ssrfBlocked } from './errors';
import {
  assertHostnamePolicy,
  assertResolvedIpAllowed,
  DEFAULT_OUTBOUND_POLICY,
  isAllowlistedHostOrIp,
  type OutboundPolicy,
  outboundPolicySnapshotSchema,
} from './policy';
import {
  defaultDnsResolve,
  defaultPinnedStreamingTransport,
  defaultPinnedTransport,
} from './transport';
import type {
  DnsResolver,
  OutboundPolicySnapshot,
  PinnedTransport,
  ResolvedAddress,
  SafeOutboundHttpClientOptions,
  SafeOutboundRequestInit,
  SafeOutboundResponse,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Shared redirect status set for fetch + streamFetch (must stay in sync). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses that force method → GET when following a redirect. */
const REDIRECT_FORCE_GET_STATUSES = new Set([301, 302, 303]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Credential headers that must not follow a cross-origin redirect. */
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
]);

type RedirectHopResult =
  | { kind: 'done' }
  | { forceGet: true; kind: 'follow'; next: URL; redirects: number }
  | { forceGet: false; kind: 'follow'; next: URL; redirects: number };

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
      translationPrefixes: options.translationPrefixes,
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
    // Drop hop-by-hop that we control
    delete baseHeaders.host;
    delete baseHeaders.Host;
    // Fixed for the whole redirect chain — same formula as streamFetch (no per-hop drift).
    const secretBearing = computeSecretBearing(init, baseHeaders, body);

    while (true) {
      this.assertUrlPolicy(current, this.getPolicy());

      const hostname = current.hostname;
      const addresses = await this.resolveHost(hostname, deadlineAt, init.signal);
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
          signal: init.signal,
          timeoutMs: remainingMs,
          url: current,
        }),
        deadlineAt,
        init.signal,
      );

      const hop = this.resolveRedirectHop({
        current,
        headers: baseHeaders,
        location: headerGet(response.headers, 'location'),
        maxRedirects,
        redirects,
        secretBearing,
        status: response.status,
        urlForLimit: current,
      });
      if (hop.kind === 'done') {
        return this.toResponse(response, current);
      }
      current = hop.next;
      redirects = hop.redirects;
      if (hop.forceGet) {
        method = 'GET';
        body = undefined;
      }
    }
  };

  /** Streaming MCP/SSE request with the same policy, redirect, DNS-pin, and byte guards. */
  streamFetch = async (
    input: string | URL,
    init: SafeOutboundRequestInit = {},
  ): Promise<Response> => {
    let current = this.parseUrl(input);
    let redirects = 0;
    const maxRedirects = init.maxRedirects ?? this.maxRedirects;
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const maxResponseBytes = init.maxResponseBytes ?? this.maxResponseBytes;
    const deadlineAt = Date.now() + timeoutMs;
    let method = (init.method ?? 'GET').toUpperCase();
    let body = toBuffer(init.body);
    const headers = { ...init.headers };
    delete headers.host;
    delete headers.Host;
    // Identical secret-bearing policy to fetch — fixed for the whole redirect chain.
    const secretBearing = computeSecretBearing(init, headers, body);

    while (true) {
      this.assertUrlPolicy(current, this.getPolicy());
      const addresses = await this.resolveHost(current.hostname, deadlineAt, init.signal);
      this.assertResolvedAddresses(current, addresses, this.getPolicy());
      const response = await defaultPinnedStreamingTransport({
        body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        family: addresses[0]!.family,
        headers,
        maxResponseBytes,
        method,
        pinnedAddress: addresses[0]!.address,
        signal: init.signal,
        timeoutMs: this.remainingMs(deadlineAt),
        url: current,
      });
      try {
        const hop = this.resolveRedirectHop({
          current,
          headers,
          location: response.headers.get('location'),
          maxRedirects,
          redirects,
          secretBearing,
          status: response.status,
          urlForLimit: current,
        });
        if (hop.kind === 'done') {
          return response;
        }
        // Drop the intermediate redirect body before following (matches prior streamFetch).
        await response.body?.cancel();
        current = hop.next;
        redirects = hop.redirects;
        if (hop.forceGet) {
          method = 'GET';
          body = undefined;
        }
      } catch (error) {
        // Cancel the unused body before propagating redirect/limit rejections.
        await response.body?.cancel();
        throw error;
      }
    }
  };

  /**
   * Shared redirect decision for fetch and streamFetch.
   * - non-redirect / missing Location → done (caller returns response)
   * - over limit / secret cross-origin → throws ssrfBlocked
   * - otherwise → follow with optional force-GET
   */
  private resolveRedirectHop(params: {
    current: URL;
    headers: Record<string, string>;
    location: string | null | undefined;
    maxRedirects: number;
    redirects: number;
    secretBearing: boolean;
    status: number;
    urlForLimit: URL;
  }): RedirectHopResult {
    if (!REDIRECT_STATUSES.has(params.status)) {
      return { kind: 'done' };
    }
    if (params.redirects >= params.maxRedirects) {
      throw ssrfBlocked('redirect_limit', 'too many redirects', {
        maxRedirects: params.maxRedirects,
        url: params.urlForLimit.toString(),
      });
    }
    if (!params.location) {
      return { kind: 'done' };
    }

    const next = this.parseUrl(new URL(params.location, params.current));
    if (!isSameOrigin(params.current, next)) {
      if (params.secretBearing) {
        throw ssrfBlocked(
          'secret_redirect',
          'cross-origin redirect rejected for secret-bearing request',
        );
      }
      stripCredentialHeaders(params.headers);
    }

    // RFC: 303 switches to GET; 301/302 historically do for browsers — follow GET for 301/302/303
    const forceGet = REDIRECT_FORCE_GET_STATUSES.has(params.status);
    return {
      forceGet,
      kind: 'follow',
      next,
      redirects: params.redirects + 1,
    };
  }

  /** Policy check without performing a network request (admin URL validation). */
  assertAllowed = async (input: string | URL): Promise<void> => {
    await this.preflight(input);
  };

  /**
   * DNS + dynamic-policy preflight that returns the exact policy version used.
   * Callers can bind this version into a proof and compare it synchronously
   * while holding their database lock.
   */
  preflight = async (input: string | URL): Promise<number | string> => {
    const deadlineAt = Date.now() + this.timeoutMs;
    const url = this.parseUrl(input);
    const before = this.getPolicySnapshot();
    this.assertUrlPolicy(url, before.policy);
    const hostname = url.hostname;
    const addresses = await this.resolveHost(hostname, deadlineAt);
    const after = this.getPolicySnapshot();
    if (after.version !== before.version) {
      throw ssrfBlocked('policy_changed', 'outbound policy changed during preflight');
    }
    this.assertResolvedAddresses(url, addresses, after.policy);
    return after.version;
  };

  /** No DNS or external I/O; safe for a short database lock comparison. */
  getPolicyVersion = (): number | string => this.getPolicySnapshot().version;

  private parseUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    } catch {
      throw ssrfBlocked('invalid_url', 'invalid URL');
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw ssrfBlocked('protocol_denied', `protocol not allowed: ${url.protocol}`, {
        protocol: url.protocol,
      });
    }
    return url;
  }

  private assertUrlPolicy(url: URL, policy: OutboundPolicy): void {
    if (isCredentialBearingUrl(url.toString())) {
      throw ssrfBlocked('credential_url', 'credential-bearing URL rejected');
    }
    assertHostnamePolicy(url.hostname, policy);
  }

  private async resolveHost(hostname: string, deadlineAt: number, signal?: AbortSignal | null) {
    const host = hostname.replaceAll(/^\[|\]$/g, '');
    if (isIP(host)) {
      const family = (isIP(host) === 6 ? 6 : 4) as 4 | 6;
      return [{ address: host, family }];
    }

    const addresses = await this.withDeadline(this.resolve(host), deadlineAt, signal);
    if (!addresses.length) {
      throw ssrfBlocked('dns_unavailable', 'DNS resolution returned no addresses', {
        hostname: host,
      });
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
    return this.getPolicySnapshot().policy;
  }

  private getPolicySnapshot(): OutboundPolicySnapshot {
    try {
      return outboundPolicySnapshotSchema.parse(this.policyProvider());
    } catch {
      throw ssrfBlocked('policy_unavailable', 'outbound policy snapshot unavailable');
    }
  }

  private remainingMs(deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw ssrfBlocked('deadline_exceeded', 'absolute deadline exceeded');
    return remaining;
  }

  private withDeadline = async <T>(
    operation: Promise<T>,
    deadlineAt: number,
    signal?: AbortSignal | null,
  ): Promise<T> => {
    const remaining = this.remainingMs(deadlineAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(ssrfBlocked('deadline_exceeded', 'absolute deadline exceeded')),
            remaining,
          );
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
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

/**
 * Shared secret-bearing classification for fetch + streamFetch.
 * Any caller header, body, explicit flag, or detected credential shape makes
 * the entire redirect chain secret-bearing (fixed at request start).
 */
const computeSecretBearing = (
  init: SafeOutboundRequestInit,
  headers: Record<string, string>,
  body: Buffer | undefined,
): boolean =>
  init.secretBearing === true ||
  Object.keys(headers).length > 0 ||
  body !== undefined ||
  hasSensitiveHeaders(headers) ||
  hasSensitiveBody(body);

/** Factory with G-07 defaults (private allowed, metadata blocked). */
export const createSafeOutboundHttpClient = (
  options?: SafeOutboundHttpClientOptions,
): SafeOutboundHttpClient => new SafeOutboundHttpClient(options);
