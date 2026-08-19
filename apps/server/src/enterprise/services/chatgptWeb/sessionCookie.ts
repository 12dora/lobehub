import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { isChatGPTWebSessionTokenSafe } from '@lobechat/utils/chatgptWebPaste';
import debug from 'debug';

import { isContextCookieJarKey, resolveCookieJarPath, seedCookieJar } from './transport';

const log = debug('lobe-server:chatgpt-web-oauth');

/** next-auth session cookie; chunked variants get a `.<n>` suffix. */
export const CHATGPT_WEB_SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';

/**
 * next-auth's own `CHUNK_SIZE` (3500). Browsers reject a single cookie above 4096 bytes,
 * and the session-token *name* plus Set-Cookie attributes (`Domain`, `Path`, `Secure`,
 * `HttpOnly`, `SameSite`, an expiry) consume a realistic ~100–200 bytes of that budget.
 * Chunking the VALUE at 4096 therefore produces cookies larger than next-auth ever emits.
 * The vault assembled-token bound (`16_384`) is independent — it is the routers' input
 * ceiling, not four of these chunks.
 */
export const CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX = 3500;

/** Matches the routers' input bound. Independent of the per-cookie chunk size. */
const MAX_SESSION_TOKEN_LENGTH = 16_384;

const SESSION_COOKIE_NAME_RE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

/**
 * Same security predicate as {@link isUsableSessionToken} in `sessionToken.ts`, kept local
 * so this module does not import that file (webSessionHeaders imports US for chunk layout).
 */
const isUsableRotatedToken = (value: string): boolean =>
  Boolean(value) &&
  value.length <= MAX_SESSION_TOKEN_LENGTH &&
  isChatGPTWebSessionTokenSafe(value) &&
  /[\w-]/.test(value);

/**
 * `__Secure-next-auth.session-token=<value>`, or its chunked form `…session-token.<n>=<value>`.
 * Global: ONE `Set-Cookie` entry can only carry one cookie, but the combined-header fallback
 * carries several, and next-auth emits every chunk of a rotation at once.
 */
const SESSION_SET_COOKIE = /__Secure-next-auth\.session-token(?:\.(\d+))?=([^\s,;]*)/g;

/** next-auth deletes a stale chunk with an empty value and/or an immediate expiry. */
const COOKIE_DELETION = /(?:^|;)\s*(?:max-age\s*=\s*0|expires\s*=\s*Thu,\s*01\s*Jan\s*1970)/i;

/** Some copy/serve paths percent-encode the cookie value; a next-auth JWE never contains `%`. */
const decodeCookieValue = (value: string): string => {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * next-auth rotates the session cookie as it is used, and a rotation invalidates the value we
 * presented — so a missed (or half-read) `Set-Cookie` strands the connection at the next
 * renewal.
 *
 * The load-bearing case is CHUNKING. A session that outgrows one cookie is emitted as
 * `…session-token.0`, `.1`, … and reading only the first chunk would persist a truncated
 * value that is not a session at all, while the value we presented has already been consumed
 * upstream — an unrecoverable connection with no error to see it by. So every entry is read,
 * the chunks are re-assembled in index order, and a set that is not CONTIGUOUS FROM 0 is
 * discarded outright: keeping the presented token merely risks a 401 that the reconnect path
 * already handles, whereas persisting a partial join guarantees a dead credential.
 *
 * `getSetCookie()` is the correct source (several `Set-Cookie` headers are not joinable),
 * with the combined header as a fallback for runtimes that lack it — hence the name-anchored
 * sweep rather than splitting on commas, which is unsafe (`Expires=Wed, 01 Jan`).
 *
 * The value is returned to the caller and NEVER logged.
 */
export interface RotatedSessionCookie {
  /** Original `.0/.1/…` values when the rotation arrived chunked. */
  chunks?: string[];
  token: string;
}

export const readRotatedSessionCookie = (response: Response): RotatedSessionCookie | undefined => {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

  const chunks = new Map<number, string>();
  let plain: string | undefined;

  for (const entry of raw) {
    if (!entry) continue;
    // A cleanup header carries the OLD name with no value — it says "this chunk is gone",
    // which must not be mistaken for a rotation to an empty (or truncated) value.
    const deleting = COOKIE_DELETION.test(entry);
    SESSION_SET_COOKIE.lastIndex = 0;
    for (
      let match = SESSION_SET_COOKIE.exec(entry);
      match;
      match = SESSION_SET_COOKIE.exec(entry)
    ) {
      const [, chunkIndex, rawValue] = match;
      const value = decodeCookieValue(rawValue);
      if (chunkIndex === undefined) {
        // next-auth clears the plain cookie by setting it empty; that is a rotation to
        // NOTHING, and keeping the presented token is the only usable answer.
        if (!deleting && value) plain = value;
        continue;
      }
      // A chunked rotation supersedes the plain cookie in the same response (next-auth
      // clears the one it is not using), so the assembled chunks win below.
      if (deleting || !value) chunks.delete(Number(chunkIndex));
      else chunks.set(Number(chunkIndex), value);
    }
  }

  if (chunks.size > 0) {
    // Contiguous from 0 by construction: a gap stops the walk short of `chunks.size`.
    const parts: string[] = [];
    for (let index = 0; index < chunks.size; index += 1) {
      const part = chunks.get(index);
      if (part === undefined) break;
      parts.push(part);
    }
    const joined = parts.join('');
    // A rotated value is about to be PERSISTED and later interpolated into a Cookie header,
    // so it is held to the same boundary rule as a pasted one: the upstream is no more
    // trusted than the operator here.
    if (parts.length === chunks.size && isUsableRotatedToken(joined)) {
      return { chunks: parts, token: joined };
    }
    // Count only — never the values, not even a fragment of one.
    log('discarding an unusable rotated session cookie (%d chunk(s))', chunks.size);
    return undefined;
  }

  if (!plain) return undefined;
  if (!isUsableRotatedToken(plain)) {
    log('discarding a rotated session cookie that is not a usable cookie value');
    return undefined;
  }
  return { token: plain };
};

/** Joined logical token only — vault/CAS bookkeeping never depends on chunk layout. */
export const readRotatedSessionToken = (response: Response): string | undefined =>
  readRotatedSessionCookie(response)?.token;

/** Split a logical token at the conservative cookie-size boundary. */
export const splitSessionTokenForCookie = (token: string): string[] => {
  if (token.length <= CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX) return [token];
  const parts: string[] = [];
  for (let offset = 0; offset < token.length; offset += CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX) {
    parts.push(token.slice(offset, offset + CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX));
  }
  return parts;
};

const chunksJoinToToken = (chunks: readonly string[] | undefined, token: string): boolean =>
  Boolean(chunks && chunks.length > 0 && chunks.every(Boolean) && chunks.join('') === token);

/**
 * Prefer the caller-supplied layout when it still joins to the logical token (a Chrome
 * paste, or a chunked Set-Cookie rotation), then the jar's current layout for the same
 * token, then a split at the cookie-size boundary.
 */
export const resolveSessionCookieChunks = (
  token: string,
  originalChunks?: readonly string[],
  jarChunks?: readonly string[],
): string[] => {
  if (originalChunks && chunksJoinToToken(originalChunks, token)) return [...originalChunks];
  if (jarChunks && chunksJoinToToken(jarChunks, token)) return [...jarChunks];
  return splitSessionTokenForCookie(token);
};

/** Cookie-header fragment: unchunked `name=value`, or `name.0=…; name.1=…`. */
export const formatSessionCookieHeader = (chunks: readonly string[]): string => {
  if (chunks.length <= 1) {
    return `${CHATGPT_WEB_SESSION_COOKIE_NAME}=${chunks[0] ?? ''}`;
  }
  return chunks
    .map((value, index) => `${CHATGPT_WEB_SESSION_COOKIE_NAME}.${index}=${value}`)
    .join('; ');
};

const netscapeCookieName = (line: string): string | undefined => {
  const rest = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
  if (!rest || rest.startsWith('#')) return undefined;
  const parts = rest.split('\t');
  return parts.length >= 7 ? parts[5] : undefined;
};

/** Drop every session-token name (plain and `.n`) so a rotation cannot leave a stale `.1`. */
const removeSessionCookiesFromJar = (path: string): void => {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const kept = text.split('\n').filter((line) => {
    const name = netscapeCookieName(line);
    return !name || !SESSION_COOKIE_NAME_RE.test(name);
  });
  writeFileSync(path, kept.join('\n'), { mode: 0o600 });
};

/**
 * Read the jar's current session-cookie layout when it still joins to `expectedToken`.
 * The jar is transport state derived from the vault token — reuse its chunks so a
 * two-chunk paste is not rewritten as one cookie on the next seed of the same token.
 */
export const readMatchingSessionChunksFromJar = (
  jarKey: string,
  expectedToken: string,
): string[] | undefined => {
  const path = resolveCookieJarPath(jarKey);
  if (!existsSync(path)) return undefined;

  const byIndex = new Map<number, string>();
  let plain: string | undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const rest = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (!rest || rest.startsWith('#')) continue;
    const parts = rest.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6] ?? '';
    if (name === CHATGPT_WEB_SESSION_COOKIE_NAME) {
      plain = value;
      continue;
    }
    const suffix = name.startsWith(`${CHATGPT_WEB_SESSION_COOKIE_NAME}.`)
      ? name.slice(CHATGPT_WEB_SESSION_COOKIE_NAME.length + 1)
      : undefined;
    if (suffix !== undefined && /^\d+$/.test(suffix) && value) byIndex.set(Number(suffix), value);
  }

  if (byIndex.size > 0) {
    const parts: string[] = [];
    for (let index = 0; index < byIndex.size; index += 1) {
      const part = byIndex.get(index);
      if (part === undefined) return undefined;
      parts.push(part);
    }
    return parts.join('') === expectedToken ? parts : undefined;
  }
  return plain && plain === expectedToken ? [plain] : undefined;
};

/**
 * Vault-authoritative session cookies for a connection. Replaces every previous
 * session-token name before installing the new set, and always seeds `oai-did`
 * from the same stored device id the headers will send.
 */
export const seedChatGPTWebSessionJar = (
  jarKey: string,
  sessionToken?: string,
  originalChunks?: readonly string[],
  deviceId?: string,
): string => {
  const path = resolveCookieJarPath(jarKey);
  const oaiDid = deviceId ?? (isContextCookieJarKey(jarKey) ? undefined : jarKey);
  const seeds: { domain: string; httpOnly?: boolean; name: string; value: string }[] = [];
  if (oaiDid) {
    seeds.push({ domain: '.chatgpt.com', name: 'oai-did', value: oaiDid });
  }
  if (sessionToken) {
    const chunks = resolveSessionCookieChunks(
      sessionToken,
      originalChunks,
      readMatchingSessionChunksFromJar(jarKey, sessionToken),
    );
    removeSessionCookiesFromJar(path);
    if (chunks.length === 1) {
      seeds.push({
        domain: '.chatgpt.com',
        httpOnly: true,
        name: CHATGPT_WEB_SESSION_COOKIE_NAME,
        value: chunks[0],
      });
    } else {
      for (const [index, value] of chunks.entries()) {
        seeds.push({
          domain: '.chatgpt.com',
          httpOnly: true,
          name: `${CHATGPT_WEB_SESSION_COOKIE_NAME}.${index}`,
          value,
        });
      }
    }
  }
  seedCookieJar(path, seeds);
  return path;
};
