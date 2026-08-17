/**
 * SSRF-safe host allowlist for upstream-supplied ChatGPT Web asset URLs.
 */

import { ChatGPTWebError } from './errors';

/**
 * Hosts an upstream-supplied URL may point at.
 *
 * Every one of these URLs (`upload_url`, `download_url`, asset pointers) is read
 * out of a response body, i.e. it is attacker-influenced input to a server-side
 * fetch. The server transport enforces its own SSRF policy; this is the second
 * line of defence, so a compromised/spoofed response cannot make the runtime
 * fetch `http://169.254.169.254/…` or an internal service with the account's
 * bearer token attached.
 */
const ASSET_HOST_SUFFIXES = [
  'chatgpt.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'blob.core.windows.net',
];

export const isAllowedAssetUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ASSET_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * @returns the parsed URL, so the caller can decide same-origin questions on the
 *   PARSED host rather than on a string prefix.
 */
export const assertAllowedAssetUrl = (url: string, context: string): URL => {
  if (!isAllowedAssetUrl(url))
    // the URL itself is never interpolated: its query string is the credential
    throw new ChatGPTWebError(
      'upstream',
      `${context}: refusing to fetch an asset from an unexpected host or scheme`,
    );
  return new URL(url);
};

/** `''` (nothing to download) or an allowlisted URL — never anything else. */
export const checkedAssetUrl = (url: string | undefined, context: string): string => {
  if (!url) return '';
  assertAllowedAssetUrl(url, context);
  return url;
};
