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
  method: string;
  /** Connect to this IP (DNS pin). */
  pinnedAddress: string;
  timeoutMs: number;
  url: URL;
}

export interface PinnedTransportResponse {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  statusText: string;
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
  timeoutMs?: number;
}

export interface SafeOutboundHttpClientOptions {
  /**
   * Host/IP allowlist. Required for useful `allowlist` mode.
   * Metadata endpoints remain blocked even when listed.
   */
  allowlist?: string[];
  maxRedirects?: number;
  /** Soft cap on response body bytes (default 5 MiB). */
  maxResponseBytes?: number;
  mode?: OutboundPolicyMode;
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
  url: string;
}
