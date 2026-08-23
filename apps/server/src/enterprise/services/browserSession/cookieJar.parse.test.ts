import { describe, expect, it } from 'vitest';

import { parseSetCookie } from './cookieJar.parse';

const defaults = { domain: '.chatgpt.com', path: '/' };
const NOW = Date.parse('2026-01-01T00:00:00Z');

describe('parseSetCookie', () => {
  it('returns undefined for empty, missing name, or invalid cookie names', () => {
    expect(parseSetCookie('  ', NOW, defaults)).toBeUndefined();
    expect(parseSetCookie('=value', NOW, defaults)).toBeUndefined();
    expect(parseSetCookie('bad name=value', NOW, defaults)).toBeUndefined();
  });

  it('applies Domain, Path, Secure, and HttpOnly attributes', () => {
    const parsed = parseSetCookie(
      'session=abc; Domain=.example.com; Path=/app; Secure; HttpOnly',
      NOW,
      defaults,
    );
    expect(parsed).toMatchObject({
      deleted: false,
      domain: '.example.com',
      expires: 0,
      httpOnly: true,
      name: 'session',
      path: '/app',
      secure: true,
      value: 'abc',
    });
  });

  it('treats Max-Age as authoritative over Expires, including deletion', () => {
    const live = parseSetCookie(
      'a=b; Max-Age=10; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      NOW,
      defaults,
    );
    expect(live?.deleted).toBe(false);
    expect(live?.expires).toBe(Math.floor(NOW / 1000) + 10);

    const deleted = parseSetCookie(
      'a=b; Max-Age=0; Expires=Wed, 01 Jan 2030 00:00:00 GMT',
      NOW,
      defaults,
    );
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.expires).toBe(1);
  });

  it('marks empty values and past Expires as deleted', () => {
    expect(parseSetCookie('a=; Domain=.chatgpt.com', NOW, defaults)?.deleted).toBe(true);
    expect(
      parseSetCookie('a=b; Expires=Wed, 01 Jan 2020 00:00:00 GMT', NOW, defaults)?.deleted,
    ).toBe(true);
  });

  it('does not treat Unix-epoch Expires as a deletion (expires=0 is a session cookie)', () => {
    const parsed = parseSetCookie('a=b; Expires=Thu, 01 Jan 1970 00:00:00 GMT', NOW, defaults);
    expect(parsed?.expires).toBe(0);
    expect(parsed?.deleted).toBe(false);
  });

  it('defaults Path to / when the attribute is present but empty', () => {
    expect(parseSetCookie('a=b; Path=', NOW, defaults)?.path).toBe('/');
  });
});
