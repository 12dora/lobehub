/**
 * SafeOutboundHttpClient — SSRF-safe outbound HTTP (G-07).
 *
 * Known residuals (see RESIDUAL.md): NAT64/SIIT IMDS encodings not decoded,
 * no port allowlist, no content-type validation. Consumers must not assume
 * those are covered.
 */
export { SafeOutboundHttpError, ssrfBlocked } from './errors';
export {
  assertHostnamePolicy,
  assertIpPolicy,
  assertResolvedIpAllowed,
  DEFAULT_OUTBOUND_POLICY,
  expandIpv6,
  extractMappedIpv4,
  isAllowlistedHostOrIp,
  isLoopbackIp,
  isMetadataHostname,
  isMetadataIp,
  isPrivateIp,
  normalizeIp,
  type OutboundPolicy,
  type OutboundPolicyMode,
} from './policy';
export {
  createSafeOutboundHttpClient,
  isSameOrigin,
  SafeOutboundHttpClient,
  stripCredentialHeaders,
} from './safeOutboundHttpClient';
export type {
  DnsResolver,
  PinnedTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
  ResolvedAddress,
  SafeOutboundHttpClientOptions,
  SafeOutboundRequestInit,
  SafeOutboundResponse,
} from './types';
