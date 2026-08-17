/**
 * Best-effort redactor used until B1's `redact.ts` is loaded.
 * Strips URL userinfo, common secret query params, auth headers, and share links.
 * TODO(B1): delete once `../redact.ts` is always present.
 */
const SECRET_QUERY =
  /([?&](?:token|key|apikey|api_key|sig|signature|password|passwd|secret|auth|access_token)=)[^&#]*/gi;
const USERINFO = /\/\/([^/@\s]+@)/g;
const AUTH_HEADER = /((?:Proxy-)?Authorization:\s*)(?:Basic|Bearer)\s+\S+/gi;
const SHARE_LINK =
  /\b(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls|socks5|https?):\/\/\S+/gi;

export const localRedactSecrets = (text: string): string => {
  if (!text) return text;
  return text
    .replaceAll(USERINFO, '//***@')
    .replaceAll(SECRET_QUERY, '$1***')
    .replaceAll(AUTH_HEADER, '$1***')
    .replaceAll(SHARE_LINK, (match) => {
      const scheme = match.split('://', 1)[0] ?? 'http';
      if (
        /\/\/[^/@\s]+@/.test(match) ||
        /^(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls|socks5):/i.test(match)
      ) {
        return `${scheme}://***`;
      }
      return match.replaceAll(USERINFO, '//***@').replaceAll(SECRET_QUERY, '$1***');
    });
};
