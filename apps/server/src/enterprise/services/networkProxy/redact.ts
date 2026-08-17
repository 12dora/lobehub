/**
 * One redactor for logs / status / errors / audit.
 *
 * Never log or return a URL with userinfo or query tokens, a proxy password,
 * engine listener credentials, or share-link payloads.
 */

const SHARE_SCHEMES = [
  'ssr',
  'ss',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'hy2',
  'tuic',
  'anytls',
  'socks5',
] as const;

const SHARE_LINK_RE = new RegExp(`\\b((?:${SHARE_SCHEMES.join('|')}):\\/\\/)\\S+`, 'gi');
/** Any URL userinfo, including username-only (`//token@host`). */
const HTTP_USERINFO_RE = /\b(https?:\/\/)[^/@\s]+@\S+/gi;
const GENERIC_USERINFO_RE = /\/\/[^/@\s]+@/g;
const SENSITIVE_QUERY_RE =
  /([?&](?:token|key|apikey|api_key|sig|signature|password|passwd|secret|auth|access_token)=)[^&#\s"'<>]*/gi;
const AUTHORIZATION_HEADER_RE = /((?:Proxy-)?Authorization:\s*(?:Basic|Bearer)\s+)[\w+/=.~-]+/gi;
const STANDALONE_BEARER_RE = /\b(Bearer\s+)([\w+/=.~-]{8,})/gi;
const STANDALONE_BASIC_RE = /\b(Basic\s+)([A-Z0-9+/]+=*)/gi;

/**
 * HTTP Basic credentials are `base64(user:pass)`. Prose such as
 * `Basic authentication is enabled` is 14 chars of base64 charset but is not a
 * padded block and does not decode to `user:pass`.
 */
const isBasicUserinfoCredential = (value: string): boolean => {
  if (value.length < 8 || value.length % 4 !== 0) return false;
  if (!/^[A-Z0-9+/]+={0,2}$/i.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (canonical !== value.replace(/=+$/, '')) return false;
  return decoded.toString('utf8').includes(':');
};

export const redactSecrets = (text: string): string => {
  if (!text) return text;
  return text
    .replaceAll(SHARE_LINK_RE, '$1***')
    .replaceAll(HTTP_USERINFO_RE, '$1***')
    .replaceAll(GENERIC_USERINFO_RE, '//')
    .replaceAll(SENSITIVE_QUERY_RE, '$1***')
    .replaceAll(AUTHORIZATION_HEADER_RE, '$1***')
    .replaceAll(STANDALONE_BEARER_RE, '$1***')
    .replaceAll(STANDALONE_BASIC_RE, (full, prefix: string, token: string) =>
      isBasicUserinfoCredential(token) ? `${prefix}***` : full,
    );
};

/** `https://host[:port]/…` → `https://host` (hostname only; never userinfo / path / query). */
export const redactUrlForDisplay = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return url.replace(/^(https?:\/\/)(?:[^@/\s]+@)?([^/:?#]+).*/i, '$1$2');
  }
};
