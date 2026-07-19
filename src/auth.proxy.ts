import { getCookieCache } from 'better-auth/cookies';

const COOKIE_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;

interface ProxySession {
  session: Record<string, unknown>;
  updatedAt?: number;
  user: Record<string, unknown> & { id: string };
}

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

const readSignedCookieCache = async (
  headers: Headers,
  requestUrl: string,
): Promise<ProxySession | null> => {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cache = await getCookieCache(headers, {
    isSecure: new URL(process.env.APP_URL || requestUrl).protocol === 'https:',
    secret,
    strategy: 'compact',
  });
  if (!isProxySession(cache)) return null;
  const updatedAt = cache.updatedAt;
  if (
    typeof updatedAt !== 'number' ||
    updatedAt > Date.now() + CLOCK_SKEW_MS ||
    Date.now() - updatedAt > COOKIE_CACHE_MAX_AGE_MS + CLOCK_SKEW_MS
  ) {
    return null;
  }
  return cache;
};

const readAuthoritativeSession = async (
  headers: Headers,
  requestUrl: string,
): Promise<ProxySession | null> => {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  const baseUrl = process.env.APP_URL || requestUrl;
  const endpoint = new URL('/api/auth/get-session?disableCookieCache=true', baseUrl);
  const response = await fetch(endpoint, {
    cache: 'no-store',
    headers: { cookie },
    method: 'GET',
    redirect: 'manual',
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
  const requestUrl = input.requestUrl || process.env.APP_URL;
  if (!requestUrl) return null;
  try {
    return (
      (await readSignedCookieCache(input.headers, requestUrl)) ??
      (await readAuthoritativeSession(input.headers, requestUrl))
    );
  } catch {
    return null;
  }
};

/** Edge-safe session reader: signed cookie first, internal Better Auth endpoint on cache miss. */
export const proxyAuth = { api: { getSession } };
