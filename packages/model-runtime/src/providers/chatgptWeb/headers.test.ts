import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACCEPT_IMAGE,
  ACCEPT_NAVIGATE,
  DEFAULT_BROWSER_DEVICE_PROFILE,
  NAVIGATION_ONLY_HEADERS,
  PRIORITY_NAVIGATE,
  PRIORITY_XHR,
} from '../../browserProfile';
import { identityFromProfile } from './browserIdentity';
import {
  buildAssetDownloadHeaders,
  buildBlobUploadHeaders,
  buildBootstrapHeaders,
  buildChatGptWebXhrHeaders,
  buildRequestHeaders,
  buildSentinelHeaders,
  buildSessionHeaders,
  buildTurnRequestHeaders,
  createTurnRequestIdentity,
  type SessionFingerprint,
} from './headers';

const fp = (overrides: Partial<SessionFingerprint> = {}): SessionFingerprint => ({
  accessToken: 'access-token',
  browserProfile: DEFAULT_BROWSER_DEVICE_PROFILE,
  deviceId: 'device-1',
  sessionId: 'session-1',
  ...overrides,
});

const PROFILE = DEFAULT_BROWSER_DEVICE_PROFILE;
const ACCEPT_LANGUAGE = PROFILE.acceptLanguage;
const DNT = PROFILE.dnt ? '1' : undefined;
const OAI_LANGUAGE = PROFILE.oaiLanguage;
const SEC_CH_UA = PROFILE.secChUa;
const SEC_CH_UA_PLATFORM = `"${PROFILE.platform}"`;
const USER_AGENT = PROFILE.userAgent;

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
  ])('strips CR/LF out of the %s', (_label, overrides) => {
    const headers = buildSessionHeaders(fp(overrides));

    expect(hasCrlf(headers)).toBe(false);
    expect(Object.keys(headers)).not.toContain('X-Injected');
  });

  it('strips CR/LF out of profile-derived language and user-agent headers', () => {
    const browserProfile = {
      ...PROFILE,
      acceptLanguage: 'en-US\r\nX-Injected: 1',
      userAgent: 'Mozilla\r\nX-Injected: 1',
    };
    expect(hasCrlf(buildSessionHeaders(fp({ browserProfile })))).toBe(false);
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
    expect(
      hasCrlf(
        buildBootstrapHeaders(
          fp({ browserProfile: { ...PROFILE, userAgent: 'UA\r\nX-Injected: 1' } }),
        ),
      ),
    ).toBe(false);
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
    expect(headers['User-Agent']).toContain(`Chrome/${PROFILE.chrome.major}`);
    expect(headers['Priority']).toBe(PRIORITY_NAVIGATE);
    expect(headers['DNT']).toBe(DNT);
    expect(headers['Accept']).toBe(ACCEPT_NAVIGATE);
    expect(headers['Accept-Language']).toBe(ACCEPT_LANGUAGE);
    expect(headers['Sec-Ch-Ua']).toBe(SEC_CH_UA);
    expect(headers['Sec-Ch-Ua-Platform']).toBe(SEC_CH_UA_PLATFORM);
    expect(headers).not.toHaveProperty('Sec-Ch-Ua-Arch');
    expect(headers).not.toHaveProperty('Sec-Ch-Ua-Full-Version-List');
  });
});

const NAVIGATION_ONLY = new Set<string>(NAVIGATION_ONLY_HEADERS);

const hasNonEmptyNavigationOnly = (headers: Record<string, string>) =>
  Object.entries(headers).some(([name, value]) => NAVIGATION_ONLY.has(name) && value.length > 0);

describe('XHR builders drop navigation-only headers', () => {
  it('buildSessionHeaders marks Sec-Fetch-User and Upgrade-Insecure-Requests for deletion', () => {
    const headers = buildSessionHeaders(fp());

    expect(headers['Sec-Fetch-User']).toBe('');
    expect(headers['Upgrade-Insecure-Requests']).toBe('');
    expect(hasNonEmptyNavigationOnly(headers)).toBe(false);
    expect(headers['User-Agent']).toBe(USER_AGENT);
    expect(headers['Sec-Ch-Ua']).toBe(SEC_CH_UA);
    expect(headers['Sec-Ch-Ua-Platform']).toBe(SEC_CH_UA_PLATFORM);
    expect(headers['Sec-Ch-Ua-Mobile']).toBe('?0');
    expect(headers['DNT']).toBe(DNT);
    expect(headers['Priority']).toBe(PRIORITY_XHR);
    expect(headers['Accept']).toBe('*/*');
    expect(headers['Accept-Language']).toBe(ACCEPT_LANGUAGE);
    expect(headers['OAI-Language']).toBe(OAI_LANGUAGE);
    expect(headers['Sec-Fetch-Dest']).toBe('empty');
    expect(headers['Sec-Fetch-Mode']).toBe('cors');
    expect(headers['Sec-Fetch-Site']).toBe('same-origin');
  });

  it('sends only the client hints chatgpt.com delegates', () => {
    // Live capture 2026-08-18: chatgpt.com returns no Accept-CH / Critical-CH, so a real
    // Chrome presents the low-entropy trio and nothing else on these calls.
    const headers = buildSessionHeaders(fp());

    for (const hint of [
      'Device-Memory',
      'Dpr',
      'Sec-Ch-Prefers-Color-Scheme',
      'Sec-Ch-Prefers-Reduced-Motion',
      'Sec-Ch-Ua-Arch',
      'Sec-Ch-Ua-Bitness',
      'Sec-Ch-Ua-Form-Factors',
      'Sec-Ch-Ua-Full-Version',
      'Sec-Ch-Ua-Full-Version-List',
      'Sec-Ch-Ua-Model',
      'Sec-Ch-Ua-Platform-Version',
      'Sec-Ch-Ua-Wow64',
      'Viewport-Width',
      'downlink',
      'ect',
      'rtt',
    ])
      expect(headers).not.toHaveProperty(hint);
  });

  it('buildChatGptWebXhrHeaders is the same set as buildSessionHeaders', () => {
    expect(
      buildChatGptWebXhrHeaders({
        accessToken: 'access-token',
        deviceId: 'device-1',
        sessionId: 'session-1',
      }),
    ).toEqual(buildSessionHeaders(fp()));
  });

  it('lets an explicit Accept override the XHR default', () => {
    const headers = buildRequestHeaders(fp(), {
      extra: { Accept: 'application/json' },
      path: '/backend-api/me',
    });
    expect(headers.Accept).toBe('application/json');
  });

  it('buildSentinelHeaders marks the navigation leftovers for deletion', () => {
    const headers = buildSentinelHeaders({
      requirements: { proofToken: 'p', soToken: 's', token: 'req', turnstileToken: 't' },
      variant: 'conduit',
    });

    expect(headers['Sec-Fetch-User']).toBe('');
    expect(headers['Upgrade-Insecure-Requests']).toBe('');
    expect(hasNonEmptyNavigationOnly(headers)).toBe(false);
  });

  it('shares one trace and observation suffix across prepare and send', () => {
    const identity = createTurnRequestIdentity();
    const prepare = buildTurnRequestHeaders(identity, 'prepare');
    const send = buildTurnRequestHeaders(identity, 'send');

    expect(prepare['X-Oai-Turn-Trace-Id']).toBe(send['X-Oai-Turn-Trace-Id']);
    expect(prepare['X-Oai-Is-Client-Observation']).toBe(`v1.r.p.${identity.observationId}`);
    expect(send['X-Oai-Is-Client-Observation']).toBe(`v1.s.p.${identity.observationId}`);
  });

  it('buildBlobUploadHeaders is a cross-site XHR with the low-entropy trio', () => {
    const headers = buildBlobUploadHeaders(fp(), 'image/png');

    expect(headers['Sec-Fetch-User']).toBe('');
    expect(headers['Upgrade-Insecure-Requests']).toBe('');
    expect(headers['Sec-Fetch-Site']).toBe('cross-site');
    expect(headers['Sec-Fetch-Mode']).toBe('cors');
    expect(headers['Sec-Fetch-Dest']).toBe('empty');
    expect(headers['Sec-Ch-Ua']).toBe(SEC_CH_UA);
    expect(headers['Sec-Ch-Ua-Mobile']).toBe('?0');
    expect(headers['Sec-Ch-Ua-Platform']).toBe(SEC_CH_UA_PLATFORM);
    expect(headers['Priority']).toBe(PRIORITY_XHR);
    expect(headers['Accept-Language']).toBe(ACCEPT_LANGUAGE);
  });

  it('buildAssetDownloadHeaders is an img-shaped GET without Origin', () => {
    const sameOrigin = buildAssetDownloadHeaders(fp(), { sameOrigin: true });
    expect(sameOrigin.Origin).toBeUndefined();
    expect(sameOrigin.Authorization).toBe('Bearer access-token');
    expect(sameOrigin['OAI-Device-Id']).toBe('device-1');
    expect(sameOrigin['OAI-Session-Id']).toBe('session-1');
    expect(sameOrigin['Sec-Fetch-Dest']).toBe('image');
    expect(sameOrigin['Sec-Fetch-Mode']).toBe('no-cors');
    expect(sameOrigin['Sec-Fetch-Site']).toBe('same-origin');
    expect(sameOrigin.Accept).toContain('image/');
    expect(sameOrigin['Sec-Fetch-User']).toBe('');
    expect(sameOrigin['Upgrade-Insecure-Requests']).toBe('');

    const crossOrigin = buildAssetDownloadHeaders(fp(), { sameOrigin: false });
    expect(crossOrigin.Authorization).toBeUndefined();
    expect(crossOrigin['Sec-Fetch-Site']).toBe('cross-site');
    expect(crossOrigin.Origin).toBeUndefined();
  });

  it('cross-origin asset downloads send no identifiers', () => {
    const identifierHeader = /^(?:authorization|oai-|x-openai-|x-aihub-)/i;
    const crossOrigin = buildAssetDownloadHeaders(fp(), { sameOrigin: false });
    expect(Object.keys(crossOrigin).filter((key) => identifierHeader.test(key))).toEqual([]);
    expect(crossOrigin.Accept).toBe(ACCEPT_IMAGE);
    expect(crossOrigin['Accept-Language']).toBe(ACCEPT_LANGUAGE);
    expect(crossOrigin.DNT).toBe(DNT);
    expect(crossOrigin.Priority).toBe(PRIORITY_XHR);
    expect(crossOrigin.Referer).toBe('https://chatgpt.com/');
    expect(crossOrigin['Sec-Ch-Ua']).toBe(SEC_CH_UA);
    expect(crossOrigin['Sec-Ch-Ua-Mobile']).toBe('?0');
    expect(crossOrigin['Sec-Ch-Ua-Platform']).toBe(SEC_CH_UA_PLATFORM);
    expect(crossOrigin).not.toHaveProperty('Sec-Ch-Ua-Arch');
    expect(crossOrigin['Sec-Fetch-Dest']).toBe('image');
    expect(crossOrigin['Sec-Fetch-Mode']).toBe('no-cors');
    expect(crossOrigin['Sec-Fetch-User']).toBe('');
    expect(crossOrigin['Upgrade-Insecure-Requests']).toBe('');
    expect(crossOrigin['User-Agent']).toBe(USER_AGENT);

    const sameOrigin = buildAssetDownloadHeaders(fp(), { sameOrigin: true });
    expect(sameOrigin.Authorization).toMatch(/^Bearer /);
    expect(sameOrigin['OAI-Device-Id']).toBe('device-1');
    expect(sameOrigin['OAI-Session-Id']).toBe('session-1');
    expect(sameOrigin['OAI-Language']).toBe(OAI_LANGUAGE);
  });
});

describe('identity derives from the shared browser profile', () => {
  it('keeps the compatibility adapter free of host literals', () => {
    expect(identityFromProfile(PROFILE).userAgent).toBe(USER_AGENT);
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'browserIdentity.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/Mozilla\/5\.0/);
    expect(src).not.toMatch(/Mac OS X 10_15_7/);
    expect(src).toMatch(/identityFromProfile/);
  });
});
