import { describe, expect, it } from 'vitest';

import { redactSecrets, redactUrlForDisplay } from './redact';

describe('redactSecrets', () => {
  it('strips URL userinfo', () => {
    expect(redactSecrets('up https://alice:s3cret@proxy.example:8443/path')).toBe('up https://***');
    expect(redactSecrets('via http://u:p@10.0.0.1:8080')).toBe('via http://***');
  });

  it('redacts sensitive query parameter values', () => {
    const names = [
      'token',
      'key',
      'apikey',
      'api_key',
      'sig',
      'signature',
      'password',
      'passwd',
      'secret',
      'auth',
      'access_token',
    ];
    for (const name of names) {
      const input = `https://cdn.example/sub?${name}=super-secret&keep=1`;
      const out = redactSecrets(input);
      expect(out).toContain(`${name}=***`);
      expect(out).not.toContain('super-secret');
      expect(out).toContain('keep=1');
    }
  });

  it('redacts Basic, Bearer, and Proxy-Authorization values', () => {
    expect(redactSecrets('Authorization: Basic YWxpY2U6c2VjcmV0')).toBe('Authorization: Basic ***');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe(
      'Authorization: Bearer ***',
    );
    expect(redactSecrets('Proxy-Authorization: Basic YWxpY2U6c2VjcmV0')).toBe(
      'Proxy-Authorization: Basic ***',
    );
  });

  it('redacts username-only URL userinfo', () => {
    expect(redactSecrets('GET https://secret-token@example.com/path')).toBe('GET https://***');
  });

  it('stops query-param redaction at JSON punctuation', () => {
    expect(redactSecrets('{"url":"https://x/p?token=secret","status":500}')).toBe(
      '{"url":"https://x/p?token=***","status":500}',
    );
  });

  it('keeps trailing context after Proxy-Authorization tokens', () => {
    expect(redactSecrets('Proxy-Authorization: Basic abc request failed host=x')).toBe(
      'Proxy-Authorization: Basic *** request failed host=x',
    );
  });

  it('always redacts standalone Bearer tokens of 8+ characters', () => {
    expect(redactSecrets('request failed Bearer supersecret')).toBe('request failed Bearer ***');
  });

  it('does not redact ordinary Basic prose', () => {
    expect(redactSecrets('Basic authentication is enabled')).toBe(
      'Basic authentication is enabled',
    );
  });

  it('redacts Authorization Basic when the value is base64(user:pass)', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
  });

  it('redacts share-link schemes to <scheme>://***', () => {
    const cases: Array<[string, string]> = [
      ['ss://YWVzLTI1Ni1nY206cGFzcw@host:443#n', 'ss://***'],
      ['ssr://payload', 'ssr://***'],
      ['vmess://eyJob3N0IjoieCJ9', 'vmess://***'],
      ['vless://uuid@host:443', 'vless://***'],
      ['trojan://pass@host:443', 'trojan://***'],
      ['hysteria2://pass@host:443', 'hysteria2://***'],
      ['hy2://pass@host:443', 'hy2://***'],
      ['tuic://uuid:pass@host:443', 'tuic://***'],
      ['anytls://pass@host:443', 'anytls://***'],
      ['socks5://user:pass@127.0.0.1:1080', 'socks5://***'],
    ];
    for (const [input, expected] of cases) {
      expect(redactSecrets(`got ${input} ok`)).toBe(`got ${expected} ok`);
    }
  });

  it('does not collapse an https URL without userinfo into https://***', () => {
    expect(redactSecrets('see https://example.com/path?q=1')).toBe(
      'see https://example.com/path?q=1',
    );
  });
});

describe('redactUrlForDisplay', () => {
  it('returns scheme + hostname only', () => {
    expect(redactUrlForDisplay('https://user:token@cdn.example:8443/sub?token=abc')).toBe(
      'https://cdn.example',
    );
    expect(redactUrlForDisplay('http://nodes.example/clash.yaml')).toBe('http://nodes.example');
  });
});
