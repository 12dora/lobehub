import {
  type BrowserDeviceProfile,
  buildClientHintHeaders,
  buildFetchMetadataHeaders,
  DEFAULT_BROWSER_DEVICE_PROFILE,
  NAVIGATION_ONLY_HEADERS,
  PRIORITY_XHR,
  userAgentHeaders,
} from '@lobechat/model-runtime/browserProfile';
import { isChatGPTWebSessionTokenSafe } from '@lobechat/utils/chatgptWebPaste';

import { ChatGPTWebOAuthError } from './oauthErrors';
import {
  formatSessionCookieHeader,
  readMatchingSessionChunksFromJar,
  resolveSessionCookieChunks,
} from './sessionCookie';

export const CHATGPT_BASE = 'https://chatgpt.com';

/**
 * Upper bound on a session token we are willing to hold. next-auth chunks a large session
 * across several cookies, so the assembled value is legitimately long — but it is stored in
 * the credential vault and re-sent on every renewal, so an upstream (or a hostile response)
 * must not be able to grow it without limit. Matches the routers' input bound.
 */
const MAX_SESSION_TOKEN_LENGTH = 16_384;

/**
 * The device id charset. It is interpolated into the same `Cookie` header as the session, and
 * unlike the connect paths (which mint a uuid v4 or validate the envelope's) a REFRESH reads
 * it from durable state — which an admin credential edit can write. `oai-did` values are
 * uuids; anything outside this charset is dropped rather than sent, because the device id is
 * a best-effort nicety and failing a renewal over it would be worse.
 */
const DEVICE_ID_CHARSET = /^[\w-]{1,128}$/;

/**
 * The one place a session token is admitted into this service.
 *
 * It ends up interpolated into a `Cookie:` request header, so a value carrying `;`, `,`, `=`,
 * whitespace or a control character would let whoever supplied it append or overwrite
 * cookies. Enforced on EVERY entry point — the pasted connect value, the credential a refresh
 * spends, and any rotated value the upstream hands back — because each of them is data from
 * outside this process.
 */
export const isUsableSessionToken = (value: string): boolean =>
  Boolean(value) &&
  value.length <= MAX_SESSION_TOKEN_LENGTH &&
  isChatGPTWebSessionTokenSafe(value) &&
  // A value consisting only of separators is well-formed for the charset and useless here.
  /[\w-]/.test(value);

export const assertSessionTokenShape = (value: string): void => {
  if (!isUsableSessionToken(value)) {
    throw new ChatGPTWebOAuthError('session_invalid', 'malformed web session token');
  }
};

/**
 * The web app's own request to `/api/auth/session`: the session travels as a COOKIE (which
 * is what it is in a browser), alongside the stable device id when we have one.
 *
 * Both values are validated before they reach this string: a cookie header is a delimiter
 * format, and everything interpolated into it comes from outside this process.
 */
export const webSessionHeaders = (
  sessionToken: string,
  deviceId?: string,
  browserProfile: BrowserDeviceProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
  sessionChunks?: readonly string[],
): Record<string, string> => {
  assertSessionTokenShape(sessionToken);
  const safeDeviceId = deviceId && DEVICE_ID_CHARSET.test(deviceId) ? deviceId : undefined;
  const cookieChunks = resolveSessionCookieChunks(
    sessionToken,
    sessionChunks,
    deviceId ? readMatchingSessionChunksFromJar(deviceId, sessionToken) : undefined,
  );

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...Object.fromEntries(
      Object.entries(userAgentHeaders(browserProfile)).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    ),
    cookie: [
      ...(safeDeviceId ? [`oai-did=${safeDeviceId}`] : []),
      formatSessionCookieHeader(cookieChunks),
    ].join('; '),
    origin: CHATGPT_BASE,
    priority: PRIORITY_XHR,
    referer: `${CHATGPT_BASE}/`,
    ...Object.fromEntries(
      Object.entries(buildClientHintHeaders(browserProfile, { entropy: 'low' })).map(
        ([name, value]) => [name.toLowerCase(), value],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(buildFetchMetadataHeaders('xhr')).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    ),
  };
  for (const name of NAVIGATION_ONLY_HEADERS) headers[name] = '';
  return headers;
};
