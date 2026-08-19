import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isBrowserCookieJarTombstoned,
  tombstoneBrowserCookieJar,
} from '../../browserSession/cookieJar';
import * as browserSessionTransport from '../../browserSession/transport';
import { H2_CERT_PATH, startH2Fixture } from '../../browserSession/transport/h2Fixture';
import {
  CONTEXT_GONE_ERROR,
  COOKIE_JAR_HEADER,
  getContextCookieJarPoolKey,
  registerContextCookieJar,
  resetCookieJars,
  unregisterContextCookieJar,
} from './cookieJar';
import {
  CHATGPT_WEB_TRANSPORT_ENV,
  getChatGPTWebFetch,
  getChatGPTWebTransportStatus,
  resetChatGPTWebFetch,
} from './curlImpersonateFetch';
import { ChatGPTWebTransportUnavailableError } from './errors';

const probe = browserSessionTransport.probeLibcurlImpersonate();
if (!probe.available) {
  console.warn(`skipping some ChatGPT Web transport routing tests: ${probe.reason}`);
}

const IMPERSONATE = 'chrome136';

afterEach(async () => {
  resetChatGPTWebFetch();
  await Promise.resolve(resetCookieJars());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.CHATGPT_WEB_ALLOWED_HOSTS;
  delete process.env.SSL_CERT_FILE;
});

describe('getChatGPTWebTransportStatus', () => {
  it('reports persistent when the library is available and env is auto', () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');
    const status = getChatGPTWebTransportStatus();
    if (probe.available) {
      expect(status.mode).toBe('persistent');
    } else {
      expect(status.mode).toBe('cli');
      expect(status.reason).toBeTruthy();
    }
  });

  it('reports CLI when CHATGPT_WEB_TRANSPORT=cli without probing', () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'cli');
    const spy = vi.spyOn(browserSessionTransport, 'probeLibcurlImpersonate');
    expect(getChatGPTWebTransportStatus()).toMatchObject({
      mode: 'cli',
      reason: `${CHATGPT_WEB_TRANSPORT_ENV}=cli`,
    });
    getChatGPTWebFetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to CLI with a reason when the probe is unavailable', () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');
    vi.spyOn(browserSessionTransport, 'probeLibcurlImpersonate').mockReturnValue({
      available: false,
      reason: 'mocked missing library',
    });
    expect(getChatGPTWebTransportStatus()).toEqual({
      mode: 'cli',
      reason: 'mocked missing library',
    });
  });

  it('throws ChatGPTWebTransportUnavailableError when persistent is required but missing', () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'persistent');
    vi.spyOn(browserSessionTransport, 'probeLibcurlImpersonate').mockReturnValue({
      available: false,
      reason: 'mocked missing library',
    });
    expect(() => getChatGPTWebFetch()).toThrow(ChatGPTWebTransportUnavailableError);
  });
});

describe('getChatGPTWebFetch stale context keys', () => {
  const digest = `ctx:${'cd'.repeat(32)}`;

  it('registered then unregistered keys fail closed on the CLI path', async () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'cli');
    registerContextCookieJar(digest, '/tmp/gone-cli.txt', 'scope-gone-cli');
    unregisterContextCookieJar(digest);
    const fetchImpl = getChatGPTWebFetch();
    await expect(
      fetchImpl('https://chatgpt.com/', { headers: { [COOKIE_JAR_HEADER]: digest } }),
    ).rejects.toThrow(CONTEXT_GONE_ERROR);
  });

  it('registered then unregistered keys fail closed on the persistent routing path', async () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');
    vi.spyOn(browserSessionTransport, 'probeLibcurlImpersonate').mockReturnValue({
      available: true,
      version: 'mock',
    });
    vi.spyOn(browserSessionTransport, 'createPersistentImpersonateFetch').mockImplementation(
      (options) =>
        (async (_input, init) => {
          const headers = new Headers(init?.headers);
          const key = headers.get(COOKIE_JAR_HEADER) ?? '';
          options?.resolvePool?.(key);
          return new Response('ok');
        }) as typeof fetch,
    );
    registerContextCookieJar(digest, '/tmp/gone-persistent.txt', 'scope-gone-persistent');
    unregisterContextCookieJar(digest);
    const fetchImpl = getChatGPTWebFetch();
    await expect(
      fetchImpl('https://chatgpt.com/', { headers: { [COOKIE_JAR_HEADER]: digest } }),
    ).rejects.toThrow(CONTEXT_GONE_ERROR);
  });

  it('throws CONTEXT_GONE for a tombstoned context-bound jar on the CLI path', async () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'cli');
    const jarPath = '/tmp/tombstone-cli.jar';
    registerContextCookieJar(digest, jarPath, 'scope-tomb-cli');
    tombstoneBrowserCookieJar(jarPath);
    const fetchImpl = getChatGPTWebFetch();
    await expect(
      fetchImpl('https://chatgpt.com/', { headers: { [COOKIE_JAR_HEADER]: digest } }),
    ).rejects.toThrow(CONTEXT_GONE_ERROR);
  });

  it('throws CONTEXT_GONE for a tombstoned context-bound jar on the persistent routing path', async () => {
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');
    vi.spyOn(browserSessionTransport, 'probeLibcurlImpersonate').mockReturnValue({
      available: true,
      version: 'mock',
    });
    vi.spyOn(browserSessionTransport, 'createPersistentImpersonateFetch').mockImplementation(
      (options) =>
        (async (_input, init) => {
          const headers = new Headers(init?.headers);
          const key = headers.get(COOKIE_JAR_HEADER) ?? '';
          const resolved = options?.resolvePool?.(key);
          if (!resolved || isBrowserCookieJarTombstoned(resolved.cookieJarPath)) {
            throw new TypeError(CONTEXT_GONE_ERROR);
          }
          return new Response('ok');
        }) as typeof fetch,
    );
    const jarPath = '/tmp/tombstone-persistent.jar';
    registerContextCookieJar(digest, jarPath, 'scope-tomb-persistent');
    tombstoneBrowserCookieJar(jarPath);
    const fetchImpl = getChatGPTWebFetch();
    await expect(
      fetchImpl('https://chatgpt.com/', { headers: { [COOKIE_JAR_HEADER]: digest } }),
    ).rejects.toThrow(CONTEXT_GONE_ERROR);
  });
});

describe.skipIf(!probe.available)('getChatGPTWebFetch request routing', () => {
  it('uses the persistent pool for a registered context digest (one H2 session)', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    process.env.SSL_CERT_FILE = H2_CERT_PATH;
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');

    const dir = mkdtempSync(path.join(tmpdir(), 'c3-route-'));
    const jar = path.join(dir, 'ctx.txt');
    registerContextCookieJar('ctx:digest-route-persistent', jar, 'scope-persistent');
    expect(getContextCookieJarPoolKey('ctx:digest-route-persistent')).toBe('scope-persistent');

    const fixture = await startH2Fixture();
    try {
      const fetchImpl = getChatGPTWebFetch(null, { impersonate: IMPERSONATE });
      const headers = { [COOKIE_JAR_HEADER]: 'ctx:digest-route-persistent' };
      await (await fetchImpl(fixture.url('/r1'), { headers })).text();
      await (await fetchImpl(fixture.url('/r2'), { headers })).text();
      expect(fixture.sessions).toBe(1);
    } finally {
      resetChatGPTWebFetch();
      await fixture.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('uses the CLI for a legacy device-id jar key (new connection per request)', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    process.env.SSL_CERT_FILE = H2_CERT_PATH;
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'auto');

    const fixture = await startH2Fixture();
    try {
      const fetchImpl = getChatGPTWebFetch(null, { impersonate: IMPERSONATE });
      const headers = { [COOKIE_JAR_HEADER]: 'legacy-device-id-not-registered' };
      await (await fetchImpl(fixture.url('/legacy-1'), { headers })).text();
      await (await fetchImpl(fixture.url('/legacy-2'), { headers })).text();
      expect(fixture.sessions).toBeGreaterThanOrEqual(2);
    } finally {
      resetChatGPTWebFetch();
      await fixture.close();
    }
  });

  it('uses the CLI when CHATGPT_WEB_TRANSPORT=cli even for a registered context', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    process.env.SSL_CERT_FILE = H2_CERT_PATH;
    vi.stubEnv(CHATGPT_WEB_TRANSPORT_ENV, 'cli');

    const dir = mkdtempSync(path.join(tmpdir(), 'c3-route-cli-'));
    const jar = path.join(dir, 'ctx.txt');
    registerContextCookieJar('ctx:digest-route-cli', jar, 'scope-cli');

    const fixture = await startH2Fixture();
    try {
      const fetchImpl = getChatGPTWebFetch(null, { impersonate: IMPERSONATE });
      const headers = { [COOKIE_JAR_HEADER]: 'ctx:digest-route-cli' };
      await (await fetchImpl(fixture.url('/cli-1'), { headers })).text();
      await (await fetchImpl(fixture.url('/cli-2'), { headers })).text();
      expect(fixture.sessions).toBeGreaterThanOrEqual(2);
    } finally {
      resetChatGPTWebFetch();
      await fixture.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
