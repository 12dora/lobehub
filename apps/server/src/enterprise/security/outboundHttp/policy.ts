import { isIP } from 'node:net';

import { z } from 'zod';

import { ssrfBlocked } from './errors';

/**
 * G-07 outbound policy modes.
 *
 * - allow-private (default): private/loopback allowed; public allowed;
 *   cloud Metadata endpoints always blocked.
 * - public-only: public Internet addresses only; private/loopback/link-local and Metadata denied.
 * - allowlist: only hostnames/IPs in allowlist (after DNS); Metadata still
 *   always blocked even if listed.
 */
export type OutboundPolicyMode = 'allow-private' | 'allowlist' | 'public-only';

export interface OutboundPolicy {
  /**
   * Hostname or IP allowlist (exact, case-insensitive host; exact IP).
   * In allowlist mode this is the only non-metadata traffic permitted.
   * In allow-private mode it is unused for allow decisions (reserved for
   * future tighten hooks).
   */
  allowlist: string[];
  mode: OutboundPolicyMode;
  /** RFC 6052 translation prefixes used by this deployment. */
  translationPrefixes?: string[];
}

const translationPrefixSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[0-9a-f:]+\/(?:32|40|48|56|64|96)$/i)
  .refine((value) => isIP(value.slice(0, value.lastIndexOf('/'))) === 6, 'invalid IPv6 prefix');

export const outboundPolicySchema = z
  .object({
    allowlist: z.array(z.string().trim().min(1).max(255)).max(256),
    mode: z.enum(['allow-private', 'allowlist', 'public-only']),
    translationPrefixes: z.array(translationPrefixSchema).max(32).optional(),
  })
  .strict();

export const outboundPolicySnapshotSchema = z
  .object({
    policy: outboundPolicySchema,
    version: z.union([z.string().trim().min(1).max(128), z.number().int().nonnegative().finite()]),
  })
  .strict();

export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = {
  allowlist: [],
  mode: 'allow-private',
};

export const DEFAULT_PUBLIC_TRANSLATION_PREFIXES = ['64:ff9b::/96', '64:ff9b:1::/48'];

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

/**
 * Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:xxxx:yyyy) to dotted IPv4.
 * Required so IMDS blocks cannot be bypassed via mapped encodings (G-07).
 */
export const extractMappedIpv4 = (ip: string): string | null => {
  const raw = ip.toLowerCase().replaceAll(/^\[|\]$/g, '');

  // ::ffff:169.254.169.254 (dotted suffix)
  const dotted = /(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (dotted?.[1] && isIP(dotted[1]) === 4) return dotted[1];

  // Full hex form after expand: 0000:0000:0000:0000:0000:ffff:a9fe:a9fe
  if (raw.includes('.')) return null;
  const expanded = expandIpv6(raw);
  const parts = expanded.split(':');
  if (
    parts.length === 8 &&
    parts[0] === '0000' &&
    parts[1] === '0000' &&
    parts[2] === '0000' &&
    parts[3] === '0000' &&
    parts[4] === '0000' &&
    parts[5] === 'ffff'
  ) {
    const hi = Number.parseInt(parts[6]!, 16);
    const lo = Number.parseInt(parts[7]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }

  return null;
};

const ipv6Bytes = (ip: string): number[] | null => {
  const expanded = expandIpv6(ip);
  if (isIP(expanded) !== 6) return null;
  return expanded.split(':').flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [(value >> 8) & 255, value & 255];
  });
};

/**
 * Decode RFC 6052 IPv4-embedded IPv6 layouts (/32,/40,/48,/56,/64,/96).
 * We inspect every standards-defined layout so network-specific NAT64/SIIT
 * prefixes cannot disguise a permanently blocked IPv4 metadata endpoint.
 */
export const extractRfc6052Ipv4Candidates = (ip: string): string[] => {
  const bytes = ipv6Bytes(ip);
  if (!bytes) return [];
  const layouts = [
    { indexes: [4, 5, 6, 7], requiresZeroUOctet: true },
    { indexes: [5, 6, 7, 9], requiresZeroUOctet: true },
    { indexes: [6, 7, 9, 10], requiresZeroUOctet: true },
    { indexes: [7, 9, 10, 11], requiresZeroUOctet: true },
    { indexes: [9, 10, 11, 12], requiresZeroUOctet: true },
    { indexes: [12, 13, 14, 15], requiresZeroUOctet: false },
  ] as const;

  const candidates = new Set<string>();
  for (const layout of layouts) {
    if (layout.requiresZeroUOctet && bytes[8] !== 0) continue;
    const candidate = layout.indexes.map((index) => bytes[index]).join('.');
    if (isIP(candidate) === 4) candidates.add(candidate);
  }
  return [...candidates];
};

const RFC6052_LAYOUTS = new Map<number, readonly number[]>([
  [32, [4, 5, 6, 7]],
  [40, [5, 6, 7, 9]],
  [48, [6, 7, 9, 10]],
  [56, [7, 9, 10, 11]],
  [64, [9, 10, 11, 12]],
  [96, [12, 13, 14, 15]],
]);

/** Decode an embedded IPv4 only when the IPv6 address matches an explicit RFC 6052 prefix. */
export const extractRfc6052Ipv4 = (ip: string, prefixCidr: string): string | null => {
  const separator = prefixCidr.lastIndexOf('/');
  const prefixLength = Number(prefixCidr.slice(separator + 1));
  const indexes = RFC6052_LAYOUTS.get(prefixLength);
  const addressBytes = ipv6Bytes(ip);
  const prefixBytes = ipv6Bytes(prefixCidr.slice(0, separator));
  if (!indexes || !addressBytes || !prefixBytes) return null;
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (addressBytes[index] !== prefixBytes[index]) return null;
  }
  if (prefixLength !== 96 && addressBytes[8] !== 0) return null;
  const candidate = indexes.map((index) => addressBytes[index]).join('.');
  return isIP(candidate) === 4 ? candidate : null;
};

export const isMetadataIp = (ip: string): boolean => {
  const mappedV4 = extractMappedIpv4(ip);
  if (mappedV4 && METADATA_IPV4.has(mappedV4)) return true;

  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (METADATA_IPV4.has(normalized)) return true;

  // normalizeIp may return expanded IPv6 — re-check mapped embedding
  const mappedFromNorm = extractMappedIpv4(normalized);
  if (mappedFromNorm && METADATA_IPV4.has(mappedFromNorm)) return true;
  if (extractRfc6052Ipv4Candidates(normalized).some((candidate) => METADATA_IPV4.has(candidate))) {
    return true;
  }

  for (const meta of METADATA_IPV6) {
    if (normalized === meta || normalized === expandIpv6(meta)) return true;
  }
  return false;
};

export const normalizeIp = (ip: string): string | null => {
  const raw = ip.replaceAll(/^\[|\]$/g, '');
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version === 6) {
    // Prefer canonical dotted IPv4 when this is a v4-mapped address
    const mapped = extractMappedIpv4(raw);
    if (mapped) return mapped;
    return expandIpv6(raw);
  }
  return null;
};

/** Expand IPv6 for stable Set membership (best-effort, lowercase). */
export const expandIpv6 = (ip: string): string => {
  const raw = ip.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (raw.includes('.')) {
    // ::ffff:a.b.c.d — convert dotted tail to two hex hextets then expand
    const m = /(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
    if (m?.[1] && isIP(m[1]) === 4) {
      const [a, b, c, d] = m[1].split('.').map(Number);
      const hi = ((a! << 8) | b!).toString(16);
      const lo = ((c! << 8) | d!).toString(16);
      return expandIpv6(`::ffff:${hi}:${lo}`);
    }
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

const ipv4ToInteger = (ip: string): number =>
  ip
    .split('.')
    .map(Number)
    .reduce((value, octet) => (value * 256 + octet) >>> 0, 0);

const isIpv4InCidr = (ip: string, network: string, prefix: number): boolean => {
  const shift = 32 - prefix;
  return ipv4ToInteger(ip) >>> shift === ipv4ToInteger(network) >>> shift;
};

const NON_PUBLIC_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

/** Conservative global-unicast classifier used only by the public-only policy. */
export const isPubliclyRoutableIp = (
  ip: string,
  translationPrefixes = DEFAULT_PUBLIC_TRANSLATION_PREFIXES,
): boolean => {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (isIP(normalized) === 4) {
    return !NON_PUBLIC_IPV4_CIDRS.some(([network, prefix]) =>
      isIpv4InCidr(normalized, network, prefix),
    );
  }

  for (const prefix of translationPrefixes) {
    const embedded = extractRfc6052Ipv4(normalized, prefix);
    if (embedded) return isPubliclyRoutableIp(embedded, []);
  }

  const parts = normalized.split(':').map((part) => Number.parseInt(part, 16));
  const [first = 0, second = 0] = parts;
  if ((first & 0xe000) !== 0x2000) return false; // IPv6 global unicast 2000::/3 only
  if (first === 0x2001 && second <= 0x01ff) return false; // transition/special-purpose block
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4 embeds an otherwise unchecked IPv4 destination
  if (first === 0x3fff && second <= 0x0fff) return false; // documentation 3fff::/20
  return true;
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

  if (
    policy.mode === 'public-only' &&
    !isPubliclyRoutableIp(
      normalized,
      policy.translationPrefixes ?? DEFAULT_PUBLIC_TRANSLATION_PREFIXES,
    )
  ) {
    throw ssrfBlocked('non-public address not permitted under public-only mode', {
      ip: normalized,
      mode: policy.mode,
    });
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
