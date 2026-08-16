import { describe, expect, it } from 'vitest';

import { buildExcerpt, redactSensitive } from './redact';

describe('redactSensitive', () => {
  it('replaces URLs, secrets, bearer, jwt, sk-keys, hex, uuid, mobile, id', () => {
    const input = [
      'see https://evil.example/path?x=1',
      'api_key=supersecret',
      'Bearer abcdef123456',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'sk-abcdefghijklmnopqrstuvwxyz',
      '0123456789abcdef0123456789abcdef',
      'QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789+/ABCDEF==',
      '550e8400-e29b-41d4-a716-446655440000',
      '13800138000',
      '110101199003078515',
    ].join(' ');

    const redacted = redactSensitive(input);
    expect(redacted).not.toContain('https://');
    expect(redacted).not.toContain('supersecret');
    expect(redacted).not.toContain('Bearer abcdef');
    expect(redacted).not.toContain('sk-abcdefgh');
    expect(redacted).not.toContain('13800138000');
    expect(redacted).toContain('[已脱敏]');
  });

  it('does not redact a long alphabetic English identifier', () => {
    const word = 'ThisisalongordinaryEnglishidentifierwithmorethanfortyeightletters';
    expect(redactSensitive(word)).toBe(word);
  });

  it('redacts mixed-class base64 and long hex, not letters-only', () => {
    const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789+/ABCDEFghijklmnop==';
    const hex = '0123456789abcdef0123456789abcdef';
    expect(redactSensitive(b64)).toBe('[已脱敏]');
    expect(redactSensitive(hex)).toBe('[已脱敏]');
    expect(redactSensitive('z'.repeat(48))).toBe('z'.repeat(48));
  });
});

describe('buildExcerpt', () => {
  it('redacts then caps with an ellipsis', () => {
    const excerpt = buildExcerpt(`safe ${'字'.repeat(600)}`, 20);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBe(20);
  });
});
