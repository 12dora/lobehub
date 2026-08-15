/**
 * Parse whatever an operator pasted into the ChatGPT Web connect box.
 *
 * The renewable credential is the chatgpt.com WEB SESSION cookie
 * (`__Secure-next-auth.session-token`, a next-auth compact JWE): it mints fresh access
 * tokens at `GET /api/auth/session` for as long as the browser session lives, which is why
 * the web app never asks anyone to sign in twice. A bare access token is still accepted,
 * but it is a 10-day dead end — nothing can renew it.
 *
 * People copy that value in very different shapes: straight out of DevTools → Application →
 * Cookies, as a whole `Cookie:` header, as a "Copy as cURL" command (bash, cmd or
 * PowerShell quoting), as the JSON body of `/api/auth/session`, or as an
 * `Authorization: Bearer …` header. Rather than parse each dialect, the pasted text is
 * SWEPT for the two things that matter — a session cookie and an access token — which
 * makes every quoting style work for free.
 *
 * The input is credential material: it is never logged, and nothing here throws with the
 * pasted text in the message.
 */

/** next-auth's session cookie on chatgpt.com. Chunked variants get a `.<n>` suffix. */
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

/**
 * `name[.<chunk>]=value`, value ending at whatever a cookie value cannot contain
 * (`;` `,` whitespace) or at the quote/backslash that wraps it inside a cURL command.
 */
const SESSION_COOKIE = /__Secure-next-auth\.session-token(?:\.(\d+))?=([^\s"',;\\]+)/g;

/** `authorization: Bearer <token>` in a header line, a cURL `-H` argument, or JSON. */
const BEARER_HEADER = /authorization["']?\s*[:=]\s*(?:["']\s*)?Bearer\s+([\w.~+/=-]+)/i;

/** A pasted header VALUE (`Bearer ey…`) with no field name in front of it. */
const BARE_BEARER = /^Bearer\s+([\w.~+/=-]+)$/i;

/** `"accessToken": "…"` — the shape `GET /api/auth/session` answers with. */
const JSON_ACCESS_TOKEN = /"access_?[tT]oken"\s*:\s*"([^"]+)"/;

/** base64url alphabet; a compact JWE/JWS segment is made of nothing else. */
const BASE64URL_SEGMENT = /^[\w-]*$/;

/**
 * The characters a session token may consist of, as a HARD boundary rule.
 *
 * The token is interpolated into a `Cookie:` request header (`name=value; name=value`), so a
 * value containing `;`, `,`, `=`, whitespace or a control character would let a caller append
 * or overwrite cookies — the pasted string is operator input and must never be trusted to be
 * a bare value. base64url plus the `.` separators of the compact serialization is exactly
 * what a next-auth JWE is made of, and it contains none of those delimiters.
 *
 * Deliberately a CHARSET rule rather than a full JWE-shape assertion: the shape check
 * (`isChatGPTWebSessionToken`) is a best-effort identification that must be allowed to drift
 * with next-auth's encoding, while this one is a security invariant that must not.
 */
export const CHATGPT_WEB_SESSION_TOKEN_PATTERN = /^[\w.-]+$/;

/** {@link CHATGPT_WEB_SESSION_TOKEN_PATTERN} as a predicate, for non-zod call sites. */
export const isChatGPTWebSessionTokenSafe = (value: string): boolean =>
  CHATGPT_WEB_SESSION_TOKEN_PATTERN.test(value);

const decodeBase64Url = (segment: string): string | undefined => {
  try {
    // Buffer in Node, atob in the browser — this module runs on both sides.
    if (typeof Buffer !== 'undefined') return Buffer.from(segment, 'base64url').toString('utf8');
    const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
    return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  } catch {
    return undefined;
  }
};

/**
 * A next-auth session token: a compact JWE (`header.encryptedKey.iv.ciphertext.tag`) whose
 * protected header declares direct encryption (`alg: 'dir'`) — next-auth derives the key
 * from the deployment secret, so the encrypted-key segment is EMPTY, which is exactly what
 * separates this from a signed JWT.
 *
 * This is the fallback identification used server-side when a stored credential predates
 * the `oauthRenewalKind` leaf; it never sees, and never needs, the plaintext.
 */
export const isChatGPTWebSessionToken = (value: string | undefined): boolean => {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 5) return false;
  if (!parts.every((part) => BASE64URL_SEGMENT.test(part))) return false;
  // header, iv, ciphertext and tag are always present; only the key segment may be empty.
  if (!parts[0] || !parts[2] || !parts[3] || !parts[4]) return false;

  const header = decodeBase64Url(parts[0]);
  if (!header) return false;
  try {
    const parsed: unknown = JSON.parse(header);
    if (!parsed || typeof parsed !== 'object') return false;
    return (parsed as { alg?: unknown }).alg === 'dir';
  } catch {
    return false;
  }
};

/** A compact JWS: three non-empty base64url segments. Access tokens are always JWTs here. */
const looksLikeJwt = (value: string): boolean => {
  const parts = value.split('.');
  return (
    parts.length === 3 && parts.every((part) => part.length > 0 && BASE64URL_SEGMENT.test(part))
  );
};

/** Cookie values are percent-encoded by some copy paths; a JWE never contains a literal `%`. */
const decodeCookieValue = (value: string): string => {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Extract the session cookie, re-assembling next-auth's chunked form
 * (`…session-token.0`, `.1`, …) which appears whenever the JWE outgrows one cookie.
 */
const extractSessionToken = (text: string): string | undefined => {
  const chunks: { index: number; value: string }[] = [];
  let plain: string | undefined;

  SESSION_COOKIE.lastIndex = 0;
  for (let match = SESSION_COOKIE.exec(text); match; match = SESSION_COOKIE.exec(text)) {
    const [, chunkIndex, value] = match;
    if (chunkIndex === undefined) plain ??= decodeCookieValue(value);
    else chunks.push({ index: Number(chunkIndex), value: decodeCookieValue(value) });
  }

  if (plain) return plain;
  if (chunks.length === 0) return undefined;
  return chunks
    .sort((a, b) => a.index - b.index)
    .map((chunk) => chunk.value)
    .join('');
};

const extractAccessToken = (text: string, single: string | undefined): string | undefined => {
  // Anchored, so it only fires when the WHOLE paste is one header value.
  const bareBearer = BARE_BEARER.exec(text);
  if (bareBearer) return bareBearer[1];

  const header = BEARER_HEADER.exec(text);
  if (header) return header[1];

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
      if (typeof token === 'string' && token.length > 0) return token;
    } catch {
      // Truncated / pretty-printed-then-mangled JSON still answers to the regex below.
    }
  }

  const json = JSON_ACCESS_TOKEN.exec(text);
  if (json) return json[1];

  if (single && looksLikeJwt(single)) return single;

  return undefined;
};

export type ChatGPTWebPasteKind = 'access_token' | 'unknown' | 'web_session';

export interface ChatGPTWebPasteResult {
  /** Present when the paste also carried a usable access token. */
  accessToken?: string;
  /**
   * `web_session` whenever a session cookie was found — it is the renewable credential, so
   * it wins over an access token pasted alongside it.
   */
  kind: ChatGPTWebPasteKind;
  sessionToken?: string;
}

/**
 * Identify what was pasted. Never throws, never logs, and returns `unknown` rather than
 * guessing — the UI states plainly what it recognised before anything is submitted.
 */
export const parseChatGPTWebPaste = (text: string): ChatGPTWebPasteResult => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { kind: 'unknown' };

  /** The whole paste as ONE token, i.e. a raw value rather than a header/command/JSON. */
  const single = /\s/.test(trimmed) ? undefined : trimmed;

  const sessionToken =
    extractSessionToken(trimmed) ??
    (single && isChatGPTWebSessionToken(single) ? single : undefined);
  const accessToken = extractAccessToken(trimmed, single);

  if (sessionToken) {
    return {
      ...(accessToken ? { accessToken } : {}),
      kind: 'web_session',
      sessionToken,
    };
  }
  if (accessToken) return { accessToken, kind: 'access_token' };
  return { kind: 'unknown' };
};

export { SESSION_COOKIE_NAME as CHATGPT_WEB_SESSION_COOKIE_NAME };
