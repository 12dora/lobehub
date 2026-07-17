import type { OutboundPolicy, OutboundPolicyMode } from './policy';

export type { OutboundPolicy, OutboundPolicyMode };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver (for unit tests / rebinding control). */
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PinnedTransportRequest {
  body?: Buffer;
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

/** Injectable low-level transport that already pins to a resolved IP. */
export type PinnedTransport = (req: PinnedTransportRequest) => Promise<PinnedTransportResponse>;

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
  timeoutMs?: number;
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
