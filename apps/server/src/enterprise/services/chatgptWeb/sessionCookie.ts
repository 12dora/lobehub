import debug from 'debug';

import { isUsableSessionToken } from './sessionToken';

const log = debug('lobe-server:chatgpt-web-oauth');

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
export const readRotatedSessionToken = (response: Response): string | undefined => {
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
    if (parts.length === chunks.size && isUsableSessionToken(joined)) return joined;
    // Count only — never the values, not even a fragment of one.
    log('discarding an unusable rotated session cookie (%d chunk(s))', chunks.size);
    return undefined;
  }

  if (!plain) return undefined;
  if (!isUsableSessionToken(plain)) {
    log('discarding a rotated session cookie that is not a usable cookie value');
    return undefined;
  }
  return plain;
};
