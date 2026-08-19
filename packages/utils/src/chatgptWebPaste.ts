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

/**
 * ChatGPT's browser device id (`OAI-Device-Id` / `oai-did`). Interpolated into a Cookie
 * header and the `OAI-Device-Id` request header, so the charset is the same injection
 * boundary as a session token: no `;`, `,`, `=`, whitespace or controls.
 */
export const CHATGPT_WEB_DEVICE_ID_PATTERN = /^[\w-]{1,128}$/;

/** `OAI-Device-Id: <id>` in a header line or a cURL `-H` argument. */
const DEVICE_ID_HEADER = /oai-device-id["']?\s*[:=]\s*["']?([\w-]+)/gi;

/** `oai-did=<id>` in a Cookie header, a `-b` flag, or a cookie string. */
const DEVICE_ID_COOKIE = /oai-did=([\w-]+)/g;

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

interface ExtractedSessionCookie {
  /** Original `.0/.1/…` values, in index order, when the paste supplied chunks. */
  chunks?: string[];
  token: string;
}

/**
 * Extract the session cookie, re-assembling next-auth's chunked form
 * (`…session-token.0`, `.1`, …) which appears whenever the JWE outgrows one cookie.
 *
 * The joined token is what the vault stores. The original chunks are kept so the
 * outbound jar can replay Chrome's layout instead of re-chunking differently.
 */
const extractSessionToken = (text: string): ExtractedSessionCookie | undefined => {
  const chunks = new Map<number, string>();
  let plain: string | undefined;

  SESSION_COOKIE.lastIndex = 0;
  for (let match = SESSION_COOKIE.exec(text); match; match = SESSION_COOKIE.exec(text)) {
    const [, chunkIndex, value] = match;
    if (chunkIndex === undefined) plain ??= decodeCookieValue(value);
    else chunks.set(Number(chunkIndex), decodeCookieValue(value));
  }

  if (plain) return { token: plain };
  if (chunks.size === 0) return undefined;

  const ordered: string[] = [];
  for (let index = 0; index < chunks.size; index += 1) {
    const part = chunks.get(index);
    if (part === undefined) break;
    ordered.push(part);
  }
  // A gapped set is still joined (best-effort identification) but is not a
  // layout we should replay — only a contiguous-from-0 set is preserved.
  if (ordered.length !== chunks.size) {
    return {
      token: [...chunks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value)
        .join(''),
    };
  }
  return { chunks: ordered, token: ordered.join('') };
};

const firstMatch = (pattern: RegExp, text: string): string | undefined => {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match?.[1];
};

/**
 * Header `OAI-Device-Id` and cookie `oai-did` must name the same browser. When both
 * are present and they disagree, the paste is rejected rather than silently picking
 * one — that disagreement is how a session gets bound to the wrong device.
 */
export const resolveChatGPTWebDeviceBinding = (
  headerId: string | undefined,
  cookieId: string | undefined,
): { deviceId?: string; mismatch: boolean } => {
  const header = headerId && CHATGPT_WEB_DEVICE_ID_PATTERN.test(headerId) ? headerId : undefined;
  const cookie = cookieId && CHATGPT_WEB_DEVICE_ID_PATTERN.test(cookieId) ? cookieId : undefined;
  if (header && cookie && header.toLowerCase() !== cookie.toLowerCase()) {
    return { mismatch: true };
  }
  return { deviceId: header ?? cookie, mismatch: false };
};

const extractDeviceBinding = (text: string): { deviceId?: string; mismatch: boolean } => {
  const header = firstMatch(DEVICE_ID_HEADER, text);
  const cookieRaw = firstMatch(DEVICE_ID_COOKIE, text);
  return resolveChatGPTWebDeviceBinding(
    header,
    cookieRaw ? decodeCookieValue(cookieRaw) : undefined,
  );
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

export type ChatGPTWebPasteKind = 'access_token' | 'device_mismatch' | 'unknown' | 'web_session';

export interface ChatGPTWebPasteResult {
  /** Present when the paste also carried a usable access token. */
  accessToken?: string;
  /**
   * ChatGPT browser device id from `OAI-Device-Id` and/or `oai-did`, when they agree.
   * Absent on a bare token paste — the server then generates one and persists it.
   */
  deviceId?: string;
  /**
   * `web_session` whenever a session cookie was found — it is the renewable credential, so
   * it wins over an access token pasted alongside it.
   * `device_mismatch` when the paste carried both a header and a cookie device id and
   * they disagree: nothing is submitted, and the UI names the conflict.
   */
  kind: ChatGPTWebPasteKind;
  /**
   * Original next-auth `.0/.1/…` cookie values, in index order. Present only when the
   * paste supplied a contiguous chunked cookie (not a single unchunked token).
   */
  sessionChunks?: string[];
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

  const binding = extractDeviceBinding(trimmed);
  if (binding.mismatch) return { kind: 'device_mismatch' };

  const session =
    extractSessionToken(trimmed) ??
    (single && isChatGPTWebSessionToken(single) ? { token: single } : undefined);
  const accessToken = extractAccessToken(trimmed, single);
  const deviceId = binding.deviceId;

  if (session) {
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(deviceId ? { deviceId } : {}),
      kind: 'web_session',
      ...(session.chunks && session.chunks.length > 1 ? { sessionChunks: session.chunks } : {}),
      sessionToken: session.token,
    };
  }
  if (accessToken) {
    return {
      accessToken,
      ...(deviceId ? { deviceId } : {}),
      kind: 'access_token',
    };
  }
  return { kind: 'unknown' };
};

export { SESSION_COOKIE_NAME as CHATGPT_WEB_SESSION_COOKIE_NAME };
