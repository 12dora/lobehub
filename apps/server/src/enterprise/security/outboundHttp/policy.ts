import { isIP } from 'node:net';

import { ssrfBlocked } from './errors';

/**
 * G-07 outbound policy modes.
 *
 * - allow-private (default): private/loopback allowed; public allowed;
 *   cloud Metadata endpoints always blocked.
 * - allowlist: only hostnames/IPs in allowlist (after DNS); Metadata still
 *   always blocked even if listed.
 */
export type OutboundPolicyMode = 'allow-private' | 'allowlist';

export interface OutboundPolicy {
  /**
   * Hostname or IP allowlist (exact, case-insensitive host; exact IP).
   * In allowlist mode this is the only non-metadata traffic permitted.
   * In allow-private mode it is unused for allow decisions (reserved for
   * future tighten hooks).
   */
  allowlist: string[];
  mode: OutboundPolicyMode;
}

export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = {
  allowlist: [],
  mode: 'allow-private',
};

/** Hostnames that always resolve to cloud instance metadata. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  // AWS / common aliases sometimes used in payloads
  'instance-data',
]);

/**
 * Cloud Metadata IPs permanently blocked in every mode (G-07).
 * Exact / known endpoints — not the entire link-local range (private MCP
 * on link-local is rare; expand only if threat model requires).
 */
const METADATA_IPV4 = new Set([
  '169.254.169.254', // AWS / Azure / DigitalOcean / GCP IMDS
  '169.254.170.2', // AWS ECS task metadata
  '169.254.169.253', // some cloud agent endpoints
]);

const METADATA_IPV6 = new Set([
  'fd00:ec2::254', // AWS IMDS IPv6
]);

export const isMetadataHostname = (hostname: string): boolean => {
  const host = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  return METADATA_HOSTNAMES.has(host);
};

export const isMetadataIp = (ip: string): boolean => {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (METADATA_IPV4.has(normalized)) return true;
  if (METADATA_IPV6.has(normalized)) return true;
  // AWS IPv6 IMDS is unique under fd00:ec2::/128 style — also match expanded form
  if (normalized === expandIpv6('fd00:ec2::254')) return true;
  return false;
};

export const normalizeIp = (ip: string): string | null => {
  const raw = ip.replaceAll(/^\[|\]$/g, '');
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version === 6) return expandIpv6(raw);
  return null;
};

/** Expand IPv6 for stable Set membership (best-effort, lowercase). */
export const expandIpv6 = (ip: string): string => {
  const raw = ip.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (raw.includes('.')) {
    // v4-mapped — keep as-is lowercased
    return raw;
  }
  const sides = raw.split('::');
  let head = sides[0] ? sides[0].split(':') : [];
  let tail = sides[1] ? sides[1].split(':') : [];
  if (sides.length === 1) {
    head = raw.split(':');
    tail = [];
  }
  const missing = 8 - (head.length + tail.length);
  const mid = missing > 0 ? Array.from({ length: missing }, () => '0') : [];
  const full = [...head, ...mid, ...tail].map((p) => p.padStart(4, '0'));
  if (full.length !== 8) return raw;
  return full.join(':');
};

export const isLoopbackIp = (ip: string): boolean => {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n === '127.0.0.1' || n.startsWith('127.')) return true;
  if (n === expandIpv6('::1')) return true;
  return false;
};

export const isPrivateIp = (ip: string): boolean => {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (isLoopbackIp(n)) return true;

  if (isIP(n) === 4) {
    const parts = n.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local (non-metadata still private-ish)
    if (a === 0) return true;
    return false;
  }

  // IPv6 ULA fc00::/7, link-local fe80::/10
  if (n.startsWith('fc') || n.startsWith('fd')) return true;
  if (n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) {
    return true;
  }
  return false;
};

export const isAllowlistedHostOrIp = (value: string, allowlist: string[]): boolean => {
  if (allowlist.length === 0) return false;
  const needle = value.replaceAll(/^\[|\]$/g, '').toLowerCase();
  const needleIp = normalizeIp(value);

  for (const entry of allowlist) {
    const e = entry.replaceAll(/^\[|\]$/g, '').toLowerCase();
    if (e === needle) return true;
    const eIp = normalizeIp(entry);
    if (needleIp && eIp && needleIp === eIp) return true;
  }
  return false;
};

/**
 * Assert hostname (pre-DNS) is not a permanent metadata name and
 * satisfies allowlist mode when applicable.
 */
export const assertHostnamePolicy = (hostname: string, policy: OutboundPolicy): void => {
  if (isMetadataHostname(hostname)) {
    throw ssrfBlocked('cloud metadata hostname is permanently blocked', { hostname });
  }

  if (policy.mode === 'allowlist') {
    // Literal IP in hostname can be checked now; DNS names checked after resolve too
    const asIp = normalizeIp(hostname);
    if (asIp && isMetadataIp(asIp)) {
      throw ssrfBlocked('cloud metadata IP is permanently blocked', { ip: asIp });
    }
    if (!isAllowlistedHostOrIp(hostname, policy.allowlist)) {
      throw ssrfBlocked('hostname not in allowlist', { hostname, mode: policy.mode });
    }
  }

  if (isIP(hostname.replaceAll(/^\[|\]$/g, ''))) {
    assertIpPolicy(hostname, policy);
  }
};

/**
 * Assert a literal IP target (no hostname allow-credit).
 * Metadata always denied. In allowlist mode the IP itself must be listed.
 */
export const assertIpPolicy = (ip: string, policy: OutboundPolicy): void => {
  assertResolvedIpAllowed(ip, policy, false);
};

/**
 * Full IP decision used by the client.
 * @param hostnameAllowListed - true when the original hostname passed allowlist
 *   (resolved IPs of an allowlisted name are permitted unless they are metadata).
 */
export const assertResolvedIpAllowed = (
  ip: string,
  policy: OutboundPolicy,
  hostnameAllowListed: boolean,
): void => {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    throw ssrfBlocked('invalid resolved IP', { ip });
  }

  if (isMetadataIp(normalized)) {
    throw ssrfBlocked('cloud metadata IP is permanently blocked', { ip: normalized });
  }

  if (policy.mode === 'allowlist') {
    const ipOnList = isAllowlistedHostOrIp(normalized, policy.allowlist);
    if (!hostnameAllowListed && !ipOnList) {
      throw ssrfBlocked('resolved IP not permitted under allowlist mode', {
        ip: normalized,
        mode: policy.mode,
      });
    }
  }

  // allow-private: public + private OK; metadata already denied above.
};
