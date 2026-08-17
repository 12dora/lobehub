import { isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * Hosts that must never go through the outlet (design §3.5).
 * Covers loopback / RFC1918 / ULA / link-local, the app's own URL, and
 * infrastructure endpoints (DB / Redis / S3 / SearXNG / Ollama).
 */
const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::', '::1']);

const INFRA_ENV_KEYS = [
  'APP_URL',
  'INTERNAL_APP_URL',
  'DATABASE_URL',
  'DATABASE_DRIVER_URL',
  'REDIS_URL',
  'KV_URL',
  'S3_ENDPOINT',
  'S3_ENDPOINT_URL',
  'AWS_ENDPOINT_URL',
  'AWS_S3_ENDPOINT',
  'SEARXNG_URL',
  'OLLAMA_PROXY_URL',
] as const;

const parseHostFromUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    return new URL(withScheme).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

const stripBrackets = (host: string): string => host.replaceAll(/^\[|\]$/g, '').toLowerCase();

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) + n;
  }
  return acc >>> 0;
};

const inCidr = (ip: string, cidr: string): boolean => {
  const [range, bitsRaw] = cidr.split('/');
  if (!range || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (isIPv4(ip) && isIPv4(range)) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const ipInt = ipv4ToInt(ip);
    const rangeInt = ipv4ToInt(range);
    if (ipInt === null || rangeInt === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffff_ffff : ~((1 << (32 - bits)) - 1) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  }
  if (isIPv6(ip) && isIPv6(range)) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    const expand = (value: string): number[] => {
      const halves = value.split('::');
      const head = halves[0] ? halves[0].split(':') : [];
      const tail = halves[1] ? halves[1].split(':') : [];
      const mid = Array.from({ length: 8 - head.length - tail.length }, () => '0');
      const groups = [...head, ...mid, ...tail].slice(0, 8);
      return groups.map((g) => Number.parseInt(g || '0', 16) || 0);
    };
    const ipGroups = expand(ip);
    const rangeGroups = expand(range);
    let remaining = bits;
    for (let i = 0; i < 8; i += 1) {
      const take = Math.min(16, remaining);
      if (take <= 0) return true;
      const mask = take === 16 ? 0xffff : ~((1 << (16 - take)) - 1) & 0xffff;
      if ((ipGroups[i]! & mask) !== (rangeGroups[i]! & mask)) return false;
      remaining -= take;
    }
    return true;
  }
  return false;
};

const isLoopbackIp = (ip: string): boolean => {
  if (isIPv4(ip)) return ip.startsWith('127.');
  if (isIPv6(ip)) {
    const compact = ip.toLowerCase();
    return compact === '::1' || compact === '0:0:0:0:0:0:0:1';
  }
  return false;
};

const isPrivateIpv4 = (ip: string): boolean =>
  inCidr(ip, '10.0.0.0/8') || inCidr(ip, '172.16.0.0/12') || inCidr(ip, '192.168.0.0/16');

const isLinkLocal = (ip: string): boolean => {
  if (isIPv4(ip)) return inCidr(ip, '169.254.0.0/16');
  if (isIPv6(ip)) return inCidr(ip, 'fe80::/10');
  return false;
};

const isUla = (ip: string): boolean => isIPv6(ip) && inCidr(ip, 'fc00::/7');

const hostMatchesBypassEntry = (host: string, ip: string | null, entry: string): boolean => {
  const raw = entry.trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('/')) {
    return ip ? inCidr(ip, raw) : false;
  }
  if (raw.startsWith('*.')) {
    const suffix = raw.slice(1); // `.example.com`
    return host === raw.slice(2) || host.endsWith(suffix);
  }
  if (raw.startsWith('.')) {
    return host === raw.slice(1) || host.endsWith(raw);
  }
  if (ip && isIP(raw) && ip === stripBrackets(raw)) return true;
  return host === raw;
};

const collectInfraHosts = (): Set<string> => {
  const hosts = new Set<string>();
  for (const key of INFRA_ENV_KEYS) {
    const host = parseHostFromUrl(process.env[key]);
    if (host) hosts.add(host);
  }
  return hosts;
};

export const isAlwaysDirectTarget = (target: URL, bypassHosts: string[]): boolean => {
  const host = stripBrackets(target.hostname);
  if (!host) return true;
  if (LOOPBACK_HOSTS.has(host)) return true;

  const ip = isIP(host) ? host : null;
  if (ip && (isLoopbackIp(ip) || isPrivateIpv4(ip) || isLinkLocal(ip) || isUla(ip))) return true;

  if (collectInfraHosts().has(host)) return true;

  for (const entry of bypassHosts) {
    if (hostMatchesBypassEntry(host, ip, entry)) return true;
  }

  return false;
};
