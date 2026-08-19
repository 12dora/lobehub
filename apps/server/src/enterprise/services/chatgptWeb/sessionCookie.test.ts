import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX,
  CHATGPT_WEB_SESSION_COOKIE_NAME,
  formatSessionCookieHeader,
  readMatchingSessionChunksFromJar,
  readRotatedSessionCookie,
  resolveSessionCookieChunks,
  seedChatGPTWebSessionJar,
  splitSessionTokenForCookie,
} from './sessionCookie';
import { resetCookieJars, seedCookieJar } from './transport';

afterEach(() => {
  resetCookieJars();
});

const sessionResponse = (setCookie: string[]) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of setCookie) headers.append('set-cookie', cookie);
  return new Response('{}', { headers, status: 200 });
};

describe('splitSessionTokenForCookie', () => {
  it('keeps a token at or under the cookie-size boundary as one value', () => {
    expect(splitSessionTokenForCookie('a'.repeat(CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX))).toEqual([
      'a'.repeat(CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX),
    ]);
  });

  it('splits a larger token on the same conservative boundary', () => {
    const token = 'a'.repeat(CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX + 10);
    expect(splitSessionTokenForCookie(token)).toEqual([
      'a'.repeat(CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX),
      'a'.repeat(10),
    ]);
  });
});

describe('resolveSessionCookieChunks', () => {
  it('preserves original paste chunks when they still join to the logical token', () => {
    expect(resolveSessionCookieChunks('AAABBB', ['AAA', 'BBB'])).toEqual(['AAA', 'BBB']);
  });

  it('ignores original chunks that no longer join, then prefers the jar layout', () => {
    expect(resolveSessionCookieChunks('AAABBB', ['XXX'], ['AAA', 'BBB'])).toEqual(['AAA', 'BBB']);
  });

  it('falls back to the cookie-size split', () => {
    const token = 'a'.repeat(CHATGPT_WEB_SESSION_COOKIE_CHUNK_MAX + 1);
    expect(resolveSessionCookieChunks(token)).toEqual(splitSessionTokenForCookie(token));
  });
});

describe('formatSessionCookieHeader', () => {
  it('emits the unchunked name for a single value', () => {
    expect(formatSessionCookieHeader(['plain'])).toBe(`${CHATGPT_WEB_SESSION_COOKIE_NAME}=plain`);
  });

  it('emits .0/.1 names for a two-chunk layout', () => {
    expect(formatSessionCookieHeader(['AAA', 'BBB'])).toBe(
      `${CHATGPT_WEB_SESSION_COOKIE_NAME}.0=AAA; ${CHATGPT_WEB_SESSION_COOKIE_NAME}.1=BBB`,
    );
  });
});

describe('readRotatedSessionCookie', () => {
  it('returns the original chunks of a chunked rotation, not just the join', () => {
    const rotated = readRotatedSessionCookie(
      sessionResponse([
        `${CHATGPT_WEB_SESSION_COOKIE_NAME}.1=second-half; Path=/`,
        `${CHATGPT_WEB_SESSION_COOKIE_NAME}.0=first-half; Path=/`,
      ]),
    );
    expect(rotated).toEqual({
      chunks: ['first-half', 'second-half'],
      token: 'first-halfsecond-half',
    });
  });

  it('returns a plain rotation without inventing chunks', () => {
    expect(
      readRotatedSessionCookie(
        sessionResponse([`${CHATGPT_WEB_SESSION_COOKIE_NAME}=rotated-plain; Path=/`]),
      ),
    ).toEqual({ token: 'rotated-plain' });
  });
});

describe('seedChatGPTWebSessionJar', () => {
  it('writes a two-chunk paste as two jar cookies and oai-did', () => {
    const deviceId = 'device-chunks';
    const path = seedChatGPTWebSessionJar(deviceId, 'AAABBB', ['AAA', 'BBB']);
    const text = readFileSync(path, 'utf8');

    expect(text).toContain('oai-did\tdevice-chunks');
    expect(text).toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}.0\tAAA`);
    expect(text).toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}.1\tBBB`);
    expect(text).not.toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}\tAAABBB`);
  });

  it('removes a stale .1 when rotating to an unchunked cookie', () => {
    const deviceId = 'device-rotate';
    seedChatGPTWebSessionJar(deviceId, 'AAABBB', ['AAA', 'BBB']);
    const path = seedChatGPTWebSessionJar(deviceId, 'plain-token');
    const text = readFileSync(path, 'utf8');

    expect(text).toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}\tplain-token`);
    expect(text).not.toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}.0`);
    expect(text).not.toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}.1`);
  });

  it('keeps Cloudflare cookies across a session rotation', () => {
    const deviceId = 'device-cf';
    const path = seedChatGPTWebSessionJar(deviceId, 'first');
    seedCookieJar(path, [{ domain: '.chatgpt.com', name: '_cfuvid', value: 'cf-1' }]);
    seedChatGPTWebSessionJar(deviceId, 'second');

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('_cfuvid\tcf-1');
    expect(text).toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}\tsecond`);
    expect(text).not.toContain(`${CHATGPT_WEB_SESSION_COOKIE_NAME}\tfirst`);
  });

  it('reuses the jar layout when reseeding the same logical token', () => {
    const deviceId = 'device-reuse';
    seedChatGPTWebSessionJar(deviceId, 'AAABBB', ['AAA', 'BBB']);
    seedChatGPTWebSessionJar(deviceId, 'AAABBB');

    expect(readMatchingSessionChunksFromJar(deviceId, 'AAABBB')).toEqual(['AAA', 'BBB']);
  });
});
