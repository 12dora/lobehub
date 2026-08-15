import { describe, expect, it } from 'vitest';

import {
  isChatGPTWebSessionToken,
  isChatGPTWebSessionTokenSafe,
  parseChatGPTWebPaste,
} from './chatgptWebPaste';

const b64url = (value: string): string =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** Compact JWE, next-auth style: `dir` header and an EMPTY encrypted-key segment. */
const jwe = (payload = 'ciphertext'): string =>
  [b64url(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })), '', 'aXY', payload, 'dGFn'].join('.');

const jwt = (claims: Record<string, unknown> = { sub: 'user' }): string =>
  [b64url(JSON.stringify({ alg: 'RS256' })), b64url(JSON.stringify(claims)), 'sig'].join('.');

describe('isChatGPTWebSessionToken', () => {
  it('accepts a compact JWE with a dir header', () => {
    expect(isChatGPTWebSessionToken(jwe())).toBe(true);
  });

  it('rejects a JWT, an opaque string and empty input', () => {
    expect(isChatGPTWebSessionToken(jwt())).toBe(false);
    expect(isChatGPTWebSessionToken('sk-not-a-token')).toBe(false);
    expect(isChatGPTWebSessionToken(undefined)).toBe(false);
    expect(isChatGPTWebSessionToken('')).toBe(false);
  });

  it('rejects five segments whose header is not JSON, or declares another alg', () => {
    expect(isChatGPTWebSessionToken(['notjson', '', 'aXY', 'c', 'dGFn'].join('.'))).toBe(false);
    expect(
      isChatGPTWebSessionToken(
        [b64url(JSON.stringify({ alg: 'RSA-OAEP' })), 'k', 'aXY', 'c', 'dGFn'].join('.'),
      ),
    ).toBe(false);
  });

  it('rejects five segments with a missing ciphertext or a non-base64url character', () => {
    expect(
      isChatGPTWebSessionToken([b64url('{"alg":"dir"}'), '', 'aXY', '', 'dGFn'].join('.')),
    ).toBe(false);
    expect(
      isChatGPTWebSessionToken([b64url('{"alg":"dir"}'), '', 'aXY', 'c!', 'dGFn'].join('.')),
    ).toBe(false);
  });
});

describe('parseChatGPTWebPaste', () => {
  it('returns unknown for empty or unrecognised input', () => {
    expect(parseChatGPTWebPaste('')).toEqual({ kind: 'unknown' });
    expect(parseChatGPTWebPaste('   \n ')).toEqual({ kind: 'unknown' });
    expect(parseChatGPTWebPaste('hello world')).toEqual({ kind: 'unknown' });
  });

  it('reads a raw session JWE', () => {
    const token = jwe();
    expect(parseChatGPTWebPaste(`  ${token}\n`)).toEqual({
      kind: 'web_session',
      sessionToken: token,
    });
  });

  it('reads a bare access-token JWT', () => {
    const token = jwt();
    expect(parseChatGPTWebPaste(token)).toEqual({ accessToken: token, kind: 'access_token' });
  });

  it('reads a `Bearer <jwt>` header value', () => {
    const token = jwt();
    expect(parseChatGPTWebPaste(`Bearer ${token}`)).toEqual({
      accessToken: token,
      kind: 'access_token',
    });
  });

  it('reads the session cookie out of a cookie string, with other cookies around it', () => {
    const token = jwe();
    const result = parseChatGPTWebPaste(
      `oai-did=abc; __Secure-next-auth.session-token=${token}; _cfuvid=zzz`,
    );
    expect(result).toEqual({ kind: 'web_session', sessionToken: token });
  });

  it('accepts a `Cookie:` header prefix and percent-encoded values', () => {
    const token = jwe();
    const result = parseChatGPTWebPaste(
      `Cookie: __Secure-next-auth.session-token=${encodeURIComponent(token)}`,
    );
    expect(result.sessionToken).toBe(token);
    expect(result.kind).toBe('web_session');
  });

  it('re-assembles next-auth chunked session cookies in index order', () => {
    const result = parseChatGPTWebPaste(
      '__Secure-next-auth.session-token.1=BBB; __Secure-next-auth.session-token.0=AAA',
    );
    expect(result).toEqual({ kind: 'web_session', sessionToken: 'AAABBB' });
  });

  it('extracts both credentials from a bash "Copy as cURL" command, preferring the session', () => {
    const session = jwe();
    const token = jwt();
    const result = parseChatGPTWebPaste(
      [
        `curl 'https://chatgpt.com/backend-api/me' \\`,
        `  -H 'accept: */*' \\`,
        `  -H 'authorization: Bearer ${token}' \\`,
        `  -H 'cookie: oai-did=1; __Secure-next-auth.session-token=${session}; other=2' \\`,
        `  --compressed`,
      ].join('\n'),
    );
    expect(result).toEqual({ accessToken: token, kind: 'web_session', sessionToken: session });
  });

  it('handles cmd/PowerShell double-quoted cURL and the -b cookie flag', () => {
    const session = jwe();
    const result = parseChatGPTWebPaste(
      `curl.exe "https://chatgpt.com/" ^\n  -b "__Secure-next-auth.session-token=${session}; a=b" ^\n  -H "accept: */*"`,
    );
    expect(result).toEqual({ kind: 'web_session', sessionToken: session });
  });

  it('reads the JSON body of /api/auth/session', () => {
    const token = jwt();
    const result = parseChatGPTWebPaste(
      JSON.stringify({
        accessToken: token,
        expires: '2026-09-01T00:00:00.000Z',
        user: { email: 'a@b.com' },
      }),
    );
    expect(result).toEqual({ accessToken: token, kind: 'access_token' });
  });

  it('still finds the access token in a truncated JSON paste', () => {
    const token = jwt();
    expect(parseChatGPTWebPaste(`{"accessToken": "${token}", "expi`)).toEqual({
      accessToken: token,
      kind: 'access_token',
    });
  });

  it('does not mistake the warning-only session body for a credential', () => {
    expect(parseChatGPTWebPaste('{"WARNING_BANNER":"do not paste"}')).toEqual({ kind: 'unknown' });
  });

  it('never returns a session token for a multi-token paste without the cookie', () => {
    expect(parseChatGPTWebPaste(`${jwe()} ${jwe()}`)).toEqual({ kind: 'unknown' });
  });
});

/**
 * The charset is a SECURITY rule, not an identification one: the value ends up interpolated
 * into a `Cookie:` request header, where `;`, `,`, `=`, whitespace and control characters are
 * delimiters. Kept separate from the JWE shape sniff, which is allowed to drift with
 * next-auth's encoding.
 */
describe('isChatGPTWebSessionTokenSafe', () => {
  it('accepts the compact base64url shape a session token actually has', () => {
    expect(isChatGPTWebSessionTokenSafe(jwe())).toBe(true);
    expect(isChatGPTWebSessionTokenSafe('rotated-plain_value.0')).toBe(true);
  });

  it.each([
    ['a cookie separator', 'jwe; oai-did=attacker'],
    ['a cookie pair separator', 'jwe,other=1'],
    ['an assignment', 'jwe=attacker'],
    ['a CRLF header break', 'jwe\r\nX-Injected: 1'],
    ['whitespace', 'jwe attacker'],
    ['a control character', 'jwe\u0001attacker'],
    ['an empty value', ''],
  ])('rejects %s', (_label, value) => {
    expect(isChatGPTWebSessionTokenSafe(value)).toBe(false);
  });
});
