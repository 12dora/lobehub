import { getCookieCache } from 'better-auth/cookies';

import {
  SESSION_COOKIE_CACHE_MAX_AGE_MS,
  SESSION_COOKIE_CACHE_STRATEGY,
} from '@/libs/better-auth/session-cookie-cache';

const CLOCK_SKEW_MS = 5000;
const MAX_FORWARDED_COOKIE_BYTES = 4096;
/** Authoritative get-session budget. Too short + fail-closed looks like logout. */
export const AUTH_GET_SESSION_TIMEOUT_MS = 8000;
export const UNKNOWN_SESSION_STATUS = 'unknown' as const;
// Mirrors Better Auth's `advanced.cookiePrefix` (AUTH_COOKIE_PREFIX); defaults
// to the stock 'better-auth' names when the env is unset.
const COOKIE_PREFIX = process.env.AUTH_COOKIE_PREFIX || 'better-auth';
const SESSION_COOKIE_NAMES = new Set(
  ['dont_remember', 'session_data', 'session_token'].flatMap((cookieName) => [
    `${COOKIE_PREFIX}.${cookieName}`,
    `__Secure-${COOKIE_PREFIX}.${cookieName}`,
  ]),
);

interface ProxySession {
  session: Record<string, unknown>;
  updatedAt?: number;
  user: Record<string, unknown> & { id: string };
}

export interface UnknownProxySession {
  status: typeof UNKNOWN_SESSION_STATUS;
}

export type ProxyGetSessionResult = ProxySession | UnknownProxySession | null;

type AuthoritativeSessionResult =
  | { kind: 'authenticated'; session: ProxySession }
  | { kind: 'unauthenticated' }
  | { kind: 'unknown' };

export const isUnknownProxySession = (
  session: ProxyGetSessionResult | undefined,
): session is UnknownProxySession =>
  !!session && 'status' in session && session.status === UNKNOWN_SESSION_STATUS;

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
    cookiePrefix: COOKIE_PREFIX,
    isSecure: PUBLIC_AUTH_ORIGIN.protocol === 'https:',
    secret,
    strategy: SESSION_COOKIE_CACHE_STRATEGY,
  });
  if (!isProxySession(cache)) return null;
  const updatedAt = cache.updatedAt;
  const now = Date.now();
  if (
    typeof updatedAt !== 'number' ||
    updatedAt > now + CLOCK_SKEW_MS ||
    now - updatedAt > SESSION_COOKIE_CACHE_MAX_AGE_MS + CLOCK_SKEW_MS
  ) {
    return null;
  }
  return cache;
};

const classifyAuthoritativeResponse = async (
  response: Response,
): Promise<AuthoritativeSessionResult> => {
  // Definitive unauthenticated: Better Auth commonly returns 200 + null, and
  // a 401 is an explicit "no session". Everything else is indeterminate.
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 429 || response.status >= 500) return { kind: 'unknown' };
  if (!response.ok) return { kind: 'unknown' };

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) return { kind: 'unknown' };

  try {
    const body: unknown = await response.json();
    if (isProxySession(body)) return { kind: 'authenticated', session: body };
    return { kind: 'unauthenticated' };
  } catch {
    return { kind: 'unknown' };
  }
};

const readAuthoritativeSession = async (headers: Headers): Promise<AuthoritativeSessionResult> => {
  if (!INTERNAL_AUTH_ORIGIN) return { kind: 'unknown' };
  const cookie = selectSessionCookies(headers.get('cookie') ?? '');
  if (!cookie) return { kind: 'unauthenticated' };
  try {
    const endpoint = new URL('/api/auth/get-session?disableCookieCache=true', INTERNAL_AUTH_ORIGIN);
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: { cookie },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(AUTH_GET_SESSION_TIMEOUT_MS),
    });
    return classifyAuthoritativeResponse(response);
  } catch {
    // Timeout, DNS, connection reset, follow-redirect errors, etc.
    return { kind: 'unknown' };
  }
};

const getSession = async (input: {
  headers: Headers;
  requestUrl?: string;
}): Promise<ProxyGetSessionResult> => {
  if (!PUBLIC_AUTH_ORIGIN || !INTERNAL_AUTH_ORIGIN) return null;
  try {
    const cached = await readSignedCookieCache(input.headers);
    if (cached) return cached;

    const authoritative = await readAuthoritativeSession(input.headers);
    switch (authoritative.kind) {
      case 'authenticated': {
        return authoritative.session;
      }
      case 'unauthenticated': {
        return null;
      }
      case 'unknown': {
        return { status: UNKNOWN_SESSION_STATUS };
      }
    }
  } catch {
    return { status: UNKNOWN_SESSION_STATUS };
  }
};

/** Edge-safe session reader: signed cookie first, trusted internal Better Auth endpoint on miss. */
export const proxyAuth = { api: { getSession } };
