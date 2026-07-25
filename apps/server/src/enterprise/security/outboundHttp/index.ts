/**
 * SafeOutboundHttpClient — SSRF-safe outbound HTTP (G-07).
 *
 * Connector consumers add protocol content-type validation at their adapter.
 */
export { SafeOutboundHttpError, ssrfBlocked } from './errors';
export {
  assertHostnamePolicy,
  assertIpPolicy,
  assertResolvedIpAllowed,
  DEFAULT_OUTBOUND_POLICY,
  expandIpv6,
  extractMappedIpv4,
  extractRfc6052Ipv4,
  extractRfc6052Ipv4Candidates,
  isAllowlistedHostOrIp,
  isLoopbackIp,
  isMetadataHostname,
  isMetadataIp,
  isPubliclyRoutableIp,
  normalizeIp,
  type OutboundPolicy,
  type OutboundPolicyMode,
  outboundPolicySchema,
  outboundPolicySnapshotSchema,
} from './policy';
export {
  createSafeOutboundFetchAdapter,
  type SafeOutboundFetchAdapterOptions,
} from './safeOutboundFetchAdapter';
export {
  createSafeOutboundHttpClient,
  isSameOrigin,
  SafeOutboundHttpClient,
  stripCredentialHeaders,
} from './safeOutboundHttpClient';
export type {
  DnsResolver,
  OutboundPolicySnapshot,
  PinnedTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
  ResolvedAddress,
  SafeOutboundHttpClientOptions,
  SafeOutboundRequestInit,
  SafeOutboundResponse,
} from './types';
