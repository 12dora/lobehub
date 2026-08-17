import type { OutboundPolicy, OutboundPolicyMode } from './policy';

export type { OutboundPolicy, OutboundPolicyMode };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver (for unit tests / rebinding control). */
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Pre-resolved egress hop attached by SafeOutbound so the transport does not
 * call `resolveEgress` a second time (which would double-count `proxied` and
 * can flip proxy→direct mid-request).
 */
export type AttachedEgressDecision =
  { mode: 'direct' } | { mode: 'proxy'; outlet: 'engine' | 'static'; proxyUrl: string };

export interface PinnedTransportRequest {
  body?: Buffer;
  /**
   * One-shot egress decision for this hop. When set, an egress-aware transport
   * must honour it and must not re-route. Direct hops never carry the
   * `0.0.0.0` placeholder pin into `defaultPinnedTransport`.
   */
  egress?: AttachedEgressDecision;
  family: 4 | 6;
  headers: Record<string, string>;
  /**
   * Hard cap on response body bytes while streaming.
   * Transport must stop reading and destroy the connection once exceeded
   * (do not buffer unbounded then truncate).
   */
  maxResponseBytes: number;
  method: string;
  /** Connect to this IP (DNS pin). */
  pinnedAddress: string;
  /** Abort DNS/connect/read work for the owning request. */
  signal?: AbortSignal | null;
  /**
   * Absolute wall-clock deadline for the entire request (ms), and socket
   * idle timeout. Continuous streaming still cannot exceed this total.
   */
  timeoutMs: number;
  url: URL;
}

export interface PinnedTransportResponse {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  statusText: string;
  /** True when the body was cut short by maxResponseBytes. */
  truncated?: boolean;
}

/**
 * Structured result from an egress-aware `resolvesRemotely` function so
 * SafeOutbound can attach the same decision to the transport request.
 */
export type RemoteResolveResult = boolean | { egress?: AttachedEgressDecision; remote: boolean };

/**
 * When `resolvesRemotely` is true (or returns true / `{ remote: true }` for the
 * hop URL), SafeOutbound skips local DNS resolve + IP pinning and only asserts
 * hostname policy. Used by the network-proxy egress transport so the engine /
 * static proxy is the DNS trust boundary.
 */
export type RemoteResolveHint =
  boolean | ((url: URL) => RemoteResolveResult | Promise<RemoteResolveResult>);

/** Injectable low-level transport that already pins to a resolved IP. */
export type PinnedTransport = ((
  req: PinnedTransportRequest,
) => Promise<PinnedTransportResponse>) & {
  resolvesRemotely?: RemoteResolveHint;
};

/**
 * Injectable streaming transport (pinned to a resolved IP) that resolves as soon as the
 * response headers arrive and hands back an un-buffered body.
 */
export type PinnedStreamingTransport = ((req: PinnedTransportRequest) => Promise<Response>) & {
  resolvesRemotely?: RemoteResolveHint;
};

export interface SafeOutboundRequestInit {
  body?: string | Buffer | Uint8Array;
  headers?: Record<string, string>;
  /** Per-call override for max redirects. */
  maxRedirects?: number;
  maxResponseBytes?: number;
  method?: string;
  /** Secret body/custom headers present: cross-origin redirects fail closed. */
  secretBearing?: boolean;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

export interface OutboundPolicySnapshot {
  policy: OutboundPolicy;
  version: number | string;
}

export interface SafeOutboundHttpClientOptions {
  /**
   * Host/IP allowlist. Required for useful `allowlist` mode.
   * Metadata endpoints remain blocked even when listed.
   */
  allowlist?: string[];
  maxRedirects?: number;
  /**
   * Hard cap on response body bytes enforced during stream read (default 5 MiB).
   * Excess data is not buffered; the connection is destroyed.
   */
  maxResponseBytes?: number;
  mode?: OutboundPolicyMode;
  /** Re-read before DNS, after DNS, and before every redirect transport hop. */
  policyProvider?: () => OutboundPolicySnapshot;
  /** Inject resolver (tests / custom). Default: dns.promises.lookup all. */
  resolve?: DnsResolver;
  /**
   * Inject the streaming transport (tests). Default: node http/https with pin that resolves
   * on headers. Policy / DNS pin / redirect / byte-cap guards run identically either way.
   */
  streamingTransport?: PinnedStreamingTransport;
  timeoutMs?: number;
  /** Deployment-specific RFC 6052 NAT64/SIIT prefixes. */
  translationPrefixes?: string[];
  /** Inject transport (tests). Default: node http/https with pin. */
  transport?: PinnedTransport;
}

export interface SafeOutboundResponse {
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: Buffer;
  headers: Headers;
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  /** True when body hit maxResponseBytes and the connection was cut. */
  truncated: boolean;
  url: string;
}
