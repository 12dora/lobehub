export const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
export const HTTPONLY_PREFIX = '#HttpOnly_';
export const COOKIE_CHUNK_SUFFIX = /\.(\d+)$/;
export const COOKIE_NAME = /^[\w.-]{1,128}$/;
export const COOKIE_DOMAIN = /^\.?[\da-z][\da-z.-]*$/i;
export const MAX_COOKIE_VALUE_LENGTH = 16_384;

export interface CookieSeed {
  domain: string;
  expires?: number;
  httpOnly?: boolean;
  name: string;
  path?: string;
  secure?: boolean;
  value: string;
}

export interface CookieRecord {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

export const cookieFamilyName = (name: string): string => name.replace(COOKIE_CHUNK_SUFFIX, '');

export const isCookieFamilyMember = (name: string, familyName: string): boolean =>
  name === familyName ||
  (name.startsWith(`${familyName}.`) && COOKIE_CHUNK_SUFFIX.test(name.slice(familyName.length)));

export const isAllowedCookieName = (name: string, allowedNames: string[]): boolean =>
  allowedNames.some((allowed) => isCookieFamilyMember(name, allowed));

/**
 * Lowercase only. A leading `.` is load-bearing Netscape identity: host-only
 * (`chatgpt.com`, tailmatch=FALSE) and domain-scoped (`.chatgpt.com`, tailmatch=TRUE)
 * are distinct cookies and can coexist. Stripping the dot would merge/clobber them.
 */
export const normalizeDomain = (domain: string): string => domain.toLowerCase();

export const cookieIdentity = (cookie: Pick<CookieRecord, 'domain' | 'name' | 'path'>): string =>
  `${cookie.name}\0${normalizeDomain(cookie.domain)}\0${cookie.path}`;

export const familyIdentity = (familyName: string, domain: string, path: string): string =>
  `${familyName}\0${normalizeDomain(domain)}\0${path}`;

export const isSafeCookieSeed = (cookie: CookieSeed): boolean => {
  if (!COOKIE_NAME.test(cookie.name)) return false;
  if (!cookie.value || cookie.value.length > MAX_COOKIE_VALUE_LENGTH) return false;
  if (/[\s,;\0]/.test(cookie.value)) return false;
  if (!COOKIE_DOMAIN.test(cookie.domain)) return false;
  if (cookie.path && /[\n\r\t]/.test(cookie.path)) return false;
  return true;
};

export const formatCookieLine = (cookie: CookieRecord): string => {
  const domain = cookie.httpOnly ? `${HTTPONLY_PREFIX}${cookie.domain}` : cookie.domain;
  const tailmatch = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  return `${domain}\t${tailmatch}\t${cookie.path}\t${secure}\t${cookie.expires}\t${cookie.name}\t${cookie.value}`;
};

export const parseCookieLine = (line: string): CookieRecord | undefined => {
  let httpOnly = false;
  let rest = line;
  if (rest.startsWith(HTTPONLY_PREFIX)) {
    httpOnly = true;
    rest = rest.slice(HTTPONLY_PREFIX.length);
  } else if (rest.startsWith('#') || rest.trim().length === 0) {
    return undefined;
  }
  const parts = rest.split('\t');
  if (parts.length < 7) return undefined;
  const [domain, , path, secure, expires, name, ...valueParts] = parts;
  if (!domain || !path || !name) return undefined;
  return {
    domain,
    expires: Number.parseInt(expires ?? '0', 10) || 0,
    httpOnly,
    name,
    path,
    secure: secure === 'TRUE',
    value: valueParts.join('\t'),
  };
};

export const toCookieRecord = (seed: CookieSeed): CookieRecord => ({
  domain: seed.domain,
  expires: seed.expires ?? 0,
  httpOnly: seed.httpOnly === true,
  name: seed.name,
  path: seed.path ?? '/',
  secure: seed.secure !== false,
  value: seed.value,
});

export const parseNetscapeCookieJarText = (text: string): CookieRecord[] => {
  const cookies: CookieRecord[] = [];
  for (const line of text.split('\n')) {
    const cookie = parseCookieLine(line.replace(/\r$/, ''));
    if (cookie) cookies.push(cookie);
  }
  return cookies;
};

export interface ParsedSetCookie {
  deleted: boolean;
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

interface SetCookieAttributes {
  domain: string;
  expiresAt: number | undefined;
  httpOnly: boolean;
  maxAge: number | undefined;
  path: string;
  secure: boolean;
}

const applySetCookieAttribute = (
  attrs: SetCookieAttributes,
  attrName: string,
  attrValue: string,
): void => {
  switch (attrName) {
    case 'domain': {
      if (attrValue) attrs.domain = attrValue;
      break;
    }
    case 'path': {
      attrs.path = attrValue || '/';
      break;
    }
    case 'secure': {
      attrs.secure = true;
      break;
    }
    case 'httponly': {
      attrs.httpOnly = true;
      break;
    }
    case 'max-age': {
      const parsed = Number.parseInt(attrValue, 10);
      if (Number.isFinite(parsed)) attrs.maxAge = parsed;
      break;
    }
    case 'expires': {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) attrs.expiresAt = Math.floor(parsed / 1000);
      break;
    }
    default: {
      break;
    }
  }
};

const parseSetCookieAttributes = (
  attrParts: string[],
  defaults: { domain: string; path: string },
): SetCookieAttributes => {
  const attrs: SetCookieAttributes = {
    domain: defaults.domain,
    expiresAt: undefined,
    httpOnly: false,
    maxAge: undefined,
    path: defaults.path,
    secure: false,
  };
  for (const raw of attrParts) {
    const part = raw.trim();
    const attrEq = part.indexOf('=');
    const attrName = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();
    applySetCookieAttribute(attrs, attrName, attrValue);
  }
  return attrs;
};

const setCookieExpires = (attrs: SetCookieAttributes, nowMs: number): number => {
  if (attrs.maxAge !== undefined) {
    return attrs.maxAge <= 0 ? 1 : Math.floor(nowMs / 1000) + attrs.maxAge;
  }
  if (attrs.expiresAt !== undefined) {
    // Netscape uses 0 for session cookies, so normalize epoch-or-earlier expiry to the
    // existing expired sentinel instead of persisting a deletion as a session cookie.
    return attrs.expiresAt <= 0 ? 1 : attrs.expiresAt;
  }
  return 0;
};

export const parseSetCookie = (
  header: string,
  nowMs: number,
  defaults: { domain: string; path: string },
): ParsedSetCookie | undefined => {
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const [head, ...attrParts] = trimmed.split(';');
  if (!head) return undefined;
  const eq = head.indexOf('=');
  if (eq <= 0) return undefined;
  const name = head.slice(0, eq).trim();
  const value = head.slice(eq + 1).trim();
  if (!COOKIE_NAME.test(name)) return undefined;

  const attrs = parseSetCookieAttributes(attrParts, defaults);
  const expires = setCookieExpires(attrs, nowMs);
  const deleted =
    value.length === 0 ||
    (attrs.maxAge !== undefined && attrs.maxAge <= 0) ||
    (expires > 0 && expires * 1000 <= nowMs);

  return {
    deleted,
    domain: attrs.domain,
    expires,
    httpOnly: attrs.httpOnly,
    name,
    path: attrs.path,
    secure: attrs.secure,
    value,
  };
};
