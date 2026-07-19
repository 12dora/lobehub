import { getCookieCache } from 'better-auth/cookies';

const COOKIE_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;
const MAX_FORWARDED_COOKIE_BYTES = 4096;
const SESSION_COOKIE_NAMES = new Set([
  '__Secure-better-auth.dont_remember',
  '__Secure-better-auth.session_data',
  '__Secure-better-auth.session_token',
  'better-auth.dont_remember',
  'better-auth.session_data',
  'better-auth.session_token',
]);

interface ProxySession {
  session: Record<string, unknown>;
  updatedAt?: number;
  user: Record<string, unknown> & { id: string };
}

const parseTrustedOrigin = (value: string | undefined, allowInternalHttp: boolean): URL | null => {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if (
      (url.protocol !== 'https:' &&
        !localHttp &&
        !(allowInternalHttp && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return new URL(url.origin);
  } catch {
    return null;
  }
};

// Resolved exactly once from deployment-controlled configuration. Request headers
// and request URLs are never authority inputs for this privileged internal call.
const PUBLIC_AUTH_ORIGIN = parseTrustedOrigin(process.env.APP_URL, false);
const INTERNAL_AUTH_ORIGIN = process.env.INTERNAL_APP_URL
  ? parseTrustedOrigin(process.env.INTERNAL_APP_URL, true)
  : PUBLIC_AUTH_ORIGIN;

const validDateAfterNow = (value: unknown): boolean => {
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > Date.now();
};

const isProxySession = (value: unknown): value is ProxySession => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !record.session ||
    typeof record.session !== 'object' ||
    Array.isArray(record.session) ||
    !record.user ||
    typeof record.user !== 'object' ||
    Array.isArray(record.user)
  ) {
    return false;
  }
  const session = record.session as Record<string, unknown>;
  const user = record.user as Record<string, unknown>;
  return (
    typeof user.id === 'string' &&
    user.id.length > 0 &&
    user.id.length <= 255 &&
    validDateAfterNow(session.expiresAt)
  );
};

const sessionCookieBaseName = (name: string): string => name.replace(/\.\d+$/, '');

const selectSessionCookies = (rawCookie: string): string | null => {
  if (rawCookie.length > 32 * 1024) return null;
  const selected: string[] = [];
  for (const segment of rawCookie.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!SESSION_COOKIE_NAMES.has(sessionCookieBaseName(name)) || !value || /[\r\n;]/.test(value)) {
      continue;
    }
    selected.push(`${name}=${value}`);
  }
  if (selected.length === 0) return null;
  const cookie = selected.join('; ');
  return new TextEncoder().encode(cookie).byteLength <= MAX_FORWARDED_COOKIE_BYTES ? cookie : null;
};

const readSignedCookieCache = async (headers: Headers): Promise<ProxySession | null> => {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !PUBLIC_AUTH_ORIGIN) return null;
  const cache = await getCookieCache(headers, {
    isSecure: PUBLIC_AUTH_ORIGIN.protocol === 'https:',
    secret,
    strategy: 'compact',
  });
  if (!isProxySession(cache)) return null;
  const updatedAt = cache.updatedAt;
  const now = Date.now();
  if (
    typeof updatedAt !== 'number' ||
    updatedAt > now + CLOCK_SKEW_MS ||
    now - updatedAt > COOKIE_CACHE_MAX_AGE_MS + CLOCK_SKEW_MS
  ) {
    return null;
  }
  return cache;
};

const readAuthoritativeSession = async (headers: Headers): Promise<ProxySession | null> => {
  if (!INTERNAL_AUTH_ORIGIN) return null;
  const cookie = selectSessionCookies(headers.get('cookie') ?? '');
  if (!cookie) return null;
  const endpoint = new URL('/api/auth/get-session?disableCookieCache=true', INTERNAL_AUTH_ORIGIN);
  const response = await fetch(endpoint, {
    cache: 'no-store',
    headers: { cookie },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return null;
  }
  const body: unknown = await response.json();
  return isProxySession(body) ? body : null;
};

const getSession = async (input: {
  headers: Headers;
  requestUrl?: string;
}): Promise<ProxySession | null> => {
  if (!PUBLIC_AUTH_ORIGIN || !INTERNAL_AUTH_ORIGIN) return null;
  try {
    return (
      (await readSignedCookieCache(input.headers)) ??
      (await readAuthoritativeSession(input.headers))
    );
  } catch {
    return null;
  }
};

/** Edge-safe session reader: signed cookie first, trusted internal Better Auth endpoint on miss. */
export const proxyAuth = { api: { getSession } };
