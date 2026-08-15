import { describe, expect, it } from 'vitest';

import {
  buildBlobUploadHeaders,
  buildBootstrapHeaders,
  buildRequestHeaders,
  buildSentinelHeaders,
  buildSessionHeaders,
  type SessionFingerprint,
} from './headers';

const fp = (overrides: Partial<SessionFingerprint> = {}): SessionFingerprint => ({
  accessToken: 'access-token',
  deviceId: 'device-1',
  sessionId: 'session-1',
  ...overrides,
});

const hasCrlf = (headers: Record<string, string>) =>
  Object.values(headers).some((value) => /[\n\r]/.test(value));

describe('CR/LF handling', () => {
  it('rejects a token that would split the request', () => {
    expect(() => buildSessionHeaders(fp({ accessToken: 'good\r\nX-Injected: 1' }))).toThrow(
      /Authorization header containing CR\/LF/,
    );
    // never echo the credential itself in the error
    try {
      buildSessionHeaders(fp({ accessToken: 'secret\r\nX-Injected: 1' }));
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it.each([
    ['path', { path: '/backend-api/me\r\nX-Injected: 1' }],
    ['route', { path: '/backend-api/me', route: '/x\nX-Injected: 1' }],
  ])('rejects a %s that would split the request', (_label, options) => {
    expect(() => buildRequestHeaders(fp(), options as any)).toThrow(/CR\/LF/);
  });

  it.each([
    ['deviceId', { deviceId: 'dev\r\nX-Injected: 1' }],
    ['sessionId', { sessionId: 'sess\nX-Injected: 1' }],
    ['locale', { locale: 'en-US\r\nX-Injected: 1' }],
    ['userAgent', { userAgent: 'Mozilla\r\nX-Injected: 1' }],
  ])('strips CR/LF out of the %s', (_label, overrides) => {
    const headers = buildSessionHeaders(fp(overrides));

    expect(hasCrlf(headers)).toBe(false);
    expect(Object.keys(headers)).not.toContain('X-Injected');
  });

  it('strips CR/LF out of extra headers, the mime type and the sentinel tokens', () => {
    expect(
      hasCrlf(
        buildRequestHeaders(fp(), {
          extra: { Referer: 'https://chatgpt.com/\r\nX-Injected: 1' },
          path: '/backend-api/me',
        }),
      ),
    ).toBe(false);

    expect(hasCrlf(buildBlobUploadHeaders(fp(), 'image/png\r\nX-Injected: 1'))).toBe(false);

    expect(
      hasCrlf(
        buildSentinelHeaders({
          conduitToken: 'conduit\r\nX-Injected: 1',
          requirements: {
            proofToken: 'proof\r\n1',
            soToken: 'so\r\n1',
            token: 'req\r\n1',
            turnstileToken: 'ts\r\n1',
          },
          variant: 'conversation',
        }),
      ),
    ).toBe(false);
  });

  it('strips CR/LF out of the bootstrap headers', () => {
    expect(hasCrlf(buildBootstrapHeaders(fp({ userAgent: 'UA\r\nX-Injected: 1' })))).toBe(false);
  });
});

describe('buildBootstrapHeaders', () => {
  it('presents no credential and no session identity to the document endpoint', () => {
    const headers = buildBootstrapHeaders(fp());

    expect(headers).not.toHaveProperty('Authorization');
    expect(Object.keys(headers).filter((key) => key.toLowerCase().startsWith('oai-'))).toEqual([]);
    expect(JSON.stringify(headers)).not.toContain('access-token');
    expect(JSON.stringify(headers)).not.toContain('device-1');
    expect(JSON.stringify(headers)).not.toContain('session-1');
  });

  it('sends the browser navigation headers', () => {
    const headers = buildBootstrapHeaders(fp());

    expect(headers['Sec-Fetch-Dest']).toBe('document');
    expect(headers['Sec-Fetch-Mode']).toBe('navigate');
    expect(headers['Sec-Fetch-Site']).toBe('none');
    expect(headers['Sec-Fetch-User']).toBe('?1');
    expect(headers['Upgrade-Insecure-Requests']).toBe('1');
    expect(headers['Accept']).toContain('text/html');
    expect(headers['User-Agent']).toContain('Chrome/136');
  });
});
