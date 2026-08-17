import { isChatGPTWebSessionTokenSafe } from '@lobechat/utils/chatgptWebPaste';

import { ChatGPTWebOAuthError } from './oauthErrors';

export const CHATGPT_BASE = 'https://chatgpt.com';
/** next-auth session cookie; the renewal credential of the web-session connect path. */
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

/** Coherent with the transport's `chrome136` impersonation profile. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
export const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"';

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
): Record<string, string> => {
  assertSessionTokenShape(sessionToken);
  const safeDeviceId = deviceId && DEVICE_ID_CHARSET.test(deviceId) ? deviceId : undefined;

  return {
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': [
      ...(safeDeviceId ? [`oai-did=${safeDeviceId}`] : []),
      `${SESSION_COOKIE_NAME}=${sessionToken}`,
    ].join('; '),
    'referer': `${CHATGPT_BASE}/`,
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'user-agent': USER_AGENT,
  };
};
