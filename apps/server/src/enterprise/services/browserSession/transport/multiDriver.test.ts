import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureBrowserCookieJarFile,
  readBrowserCookieJar,
  replaceBrowserCookieFamily,
  resetBrowserCookieJars,
  seedBrowserCookieJar,
} from '../cookieJar';
import { H2_CERT_PATH, type H2Fixture, startH2Fixture } from './h2Fixture';
import { fetchFailedMulti, type LibcurlBindings, probeLibcurlImpersonate } from './libcurlFfi';
import {
  createLibcurlMultiDriver,
  type LibcurlMultiDriver,
  type LibcurlPoolIdentity,
} from './multiDriver';

const probe = probeLibcurlImpersonate();
if (!probe.available) {
  console.warn(`skipping libcurl multiDriver tests: ${probe.reason}`);
}

const IMPERSONATE = 'chrome136';

const poolOf = (scope: string, origin: string, proxyOutlet = ''): LibcurlPoolIdentity => ({
  key: `${scope}|${origin}|${proxyOutlet}|${IMPERSONATE}`,
  origin,
  proxyOutlet,
  scope,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

describe('fetchFailedMulti', () => {
  const bindings = {
    curl_multi_strerror: (code: number) => `CURLMcode ${code} detail`,
  } as unknown as LibcurlBindings;

  it('shapes perform/poll CURLM codes as fetch failed: curl(N)', () => {
    expect(fetchFailedMulti(bindings, 2)).toMatchObject({
      message: 'fetch failed: curl(2): CURLMcode 2 detail',
      name: 'TypeError',
    });
  });

  it('shapes poll exceptions as fetch failed: curl(0) and never passes a raw Error through', () => {
    const raw = new Error('poll exploded');
    const error = fetchFailedMulti(bindings, raw);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBe(raw);
    expect(error.constructor).toBe(TypeError);
    expect(error.message).toBe('fetch failed: curl(0): poll exploded');
  });

  it('shapes pool init failures as fetch failed: curl(N) TypeErrors', () => {
    expect(fetchFailedMulti(bindings, 0, 'curl_multi_init returned null')).toMatchObject({
      message: 'fetch failed: curl(0): curl_multi_init returned null',
      name: 'TypeError',
    });
    expect(fetchFailedMulti(bindings, 4)).toMatchObject({
      message: 'fetch failed: curl(4): CURLMcode 4 detail',
      name: 'TypeError',
    });
  });
});

describe.skipIf(!probe.available)('createLibcurlMultiDriver', () => {
  let fixture: H2Fixture;
  let driver: LibcurlMultiDriver;
  const tempDirs: string[] = [];

  beforeAll(() => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
  });

  afterEach(async () => {
    await driver?.drainAll();
    await fixture?.close();
    resetBrowserCookieJars();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  const boot = async () => {
    fixture = await startH2Fixture();
    driver = createLibcurlMultiDriver();
    return { driver, fixture };
  };

  const get = (
    path: string,
    identity?: LibcurlPoolIdentity,
    extra?: Partial<Parameters<LibcurlMultiDriver['submit']>[1]>,
  ) => {
    const id = identity ?? poolOf('ctx-a', fixture.origin);
    return driver.submit(id, {
      caBundle: H2_CERT_PATH,
      headers: [],
      impersonate: IMPERSONATE,
      method: 'GET',
      timeoutMs: 10_000,
      url: fixture.url(path),
      ...extra,
    });
  };

  it('reuses one HTTP/2 session for three sequential requests on one pool key', async () => {
    await boot();
    const identity = poolOf('seq', fixture.origin);
    for (const path of ['/a', '/b', '/c']) {
      const response = await get(path, identity);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(fixture.sessions).toBe(1);
  });

  it('multiplexes parallel streams on one session', async () => {
    await boot();
    const identity = poolOf('par', fixture.origin);
    const responses = await Promise.all([
      get('/overlap/1', identity),
      get('/overlap/2', identity),
      get('/overlap/3', identity),
    ]);
    expect(responses.map((item) => item.status)).toEqual([200, 200, 200]);
    await Promise.all(responses.map((item) => item.text()));
    expect(fixture.sessions).toBe(1);
    expect(fixture.concurrentMax).toBeGreaterThan(1);
  });

  it('isolates connections and cookies across pool keys', async () => {
    await boot();
    const dir = mkdtempSync(path.join(tmpdir(), 'c3-jars-'));
    tempDirs.push(dir);
    const jarA = path.join(dir, 'a.txt');
    const jarB = path.join(dir, 'b.txt');
    ensureBrowserCookieJarFile(jarA);
    ensureBrowserCookieJarFile(jarB);

    const poolA = poolOf('ctx-a', fixture.origin);
    const poolB = poolOf('ctx-b', fixture.origin);

    const set = await get('/set-cookie', poolA, { cookieJarPath: jarA });
    await set.text();

    const nextA = await get('/after-a', poolA, { cookieJarPath: jarA });
    await nextA.text();
    const nextB = await get('/after-b', poolB, { cookieJarPath: jarB });
    await nextB.text();

    expect(fixture.sessions).toBe(2);
    const cookieA = fixture.captured.find((item) => item.url === '/after-a')?.headers.cookie;
    const cookieB = fixture.captured.find((item) => item.url === '/after-b')?.headers.cookie;
    expect(cookieA).toMatch(/c3test=1/);
    expect(cookieB ?? '').not.toMatch(/c3test/);
    expect(readFileSync(jarA, 'utf8')).toContain('c3test');
    expect(readFileSync(jarB, 'utf8')).not.toContain('c3test');
  });

  it('drain(key) closes the session and the next request opens a new one', async () => {
    await boot();
    const identity = poolOf('drain-me', fixture.origin);
    await (await get('/one', identity)).text();
    expect(fixture.sessions).toBe(1);
    const closesBefore = fixture.sessionCloses;
    await driver.drain(identity.key);
    await fixture.waitForSessionClose(closesBefore);
    await (await get('/two', identity)).text();
    expect(fixture.sessions).toBe(2);
  });

  it('abort mid-stream errors with AbortError and releases the handle', async () => {
    await boot();
    const controller = new AbortController();
    const response = await get('/slow', undefined, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => driver.stats().inFlight === 0);
    expect(driver.stats().inFlight).toBe(0);
  });

  it('timeout rejects with curl(28)', async () => {
    await boot();
    await expect(get('/hang', undefined, { timeoutMs: 250 })).rejects.toThrow(/curl\(28\)/);
    await waitFor(() => driver.stats().inFlight === 0);
  });

  it('applies backpressure and releases an unread stalled body', async () => {
    await boot();
    const response = await get('/flood', undefined, { bodyStallTimeoutMs: 250 });
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(driver.stats().bufferedBodyBytes).toBeLessThan(256 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(reader.read()).rejects.toThrow(
      'fetch failed: the ChatGPT Web transport response body was not consumed within 250ms; the request was cancelled.',
    );
    await waitFor(() => driver.stats().inFlight === 0);
  }, 10_000);

  it('parses the response head, including 1xx-then-200', async () => {
    await boot();
    const json = await get('/json');
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(json.headers.get('x-test')).toBe('yes');
    await expect(json.json()).resolves.toEqual({ ok: true });

    const continued = await get('/continue');
    expect(continued.status).toBe(200);
    await expect(continued.json()).resolves.toEqual({ continued: true });
  });

  it('sends POST JSON, non-ASCII, multi-MB, PATCH/DELETE, and empty POST Content-Length 0', async () => {
    await boot();
    const identity = poolOf('bodies', fixture.origin);

    const jsonBody = new TextEncoder().encode(JSON.stringify({ hello: '世界' }));
    const jsonResponse = await driver.submit(identity, {
      body: jsonBody,
      caBundle: H2_CERT_PATH,
      headers: [['content-type', 'application/json']],
      impersonate: IMPERSONATE,
      method: 'POST',
      timeoutMs: 10_000,
      url: fixture.url('/echo/json'),
    });
    expect(Buffer.from(await jsonResponse.arrayBuffer()).equals(Buffer.from(jsonBody))).toBe(true);

    const big = Buffer.alloc(2 * 1024 * 1024, 0x62);
    const bigResponse = await driver.submit(identity, {
      body: big,
      caBundle: H2_CERT_PATH,
      headers: [],
      impersonate: IMPERSONATE,
      method: 'POST',
      timeoutMs: 15_000,
      url: fixture.url('/echo/big'),
    });
    expect(Buffer.from(await bigResponse.arrayBuffer()).equals(big)).toBe(true);

    const patched = await driver.submit(identity, {
      body: new TextEncoder().encode('x'),
      caBundle: H2_CERT_PATH,
      headers: [],
      impersonate: IMPERSONATE,
      method: 'PATCH',
      timeoutMs: 10_000,
      url: fixture.url('/echo/patch'),
    });
    await patched.arrayBuffer();
    expect(fixture.captured.at(-1)?.headers[':method']).toBe('PATCH');

    const deleted = await driver.submit(identity, {
      caBundle: H2_CERT_PATH,
      headers: [],
      impersonate: IMPERSONATE,
      method: 'DELETE',
      timeoutMs: 10_000,
      url: fixture.url('/delete'),
    });
    await deleted.text();
    expect(fixture.captured.at(-1)?.headers[':method']).toBe('DELETE');

    const empty = await driver.submit(identity, {
      body: new Uint8Array(0),
      caBundle: H2_CERT_PATH,
      headers: [],
      impersonate: IMPERSONATE,
      method: 'POST',
      timeoutMs: 10_000,
      url: fixture.url('/echo/empty'),
    });
    await empty.arrayBuffer();
    expect(fixture.captured.at(-1)?.headers[':method']).toBe('POST');
    expect(fixture.captured.at(-1)?.headers['content-length']).toBe('0');
  });

  it('drains an in-flight request then recreates the pool under the same key', async () => {
    await boot();
    const identity = poolOf('drain-recreate', fixture.origin);
    const hanging = get('/hang', identity, { timeoutMs: 8000 });
    await waitFor(() => driver.stats().polling > 0);
    expect(driver.stats().pollEntered).toBeGreaterThan(0);
    const drained = driver.drain(identity.key);
    const next = get('/json', identity);
    await expect(hanging).rejects.toThrow(/drained/);
    await drained;
    const response = await next;
    expect(response.status).toBe(200);
    await response.text();
    expect(driver.stats().inFlight).toBe(0);
  }, 10_000);

  it('aborts a request while the pool is polling', async () => {
    await boot();
    const controller = new AbortController();
    const hanging = get('/hang', undefined, { signal: controller.signal, timeoutMs: 8000 });
    await waitFor(() => driver.stats().polling > 0);
    controller.abort();
    await expect(hanging).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => driver.stats().inFlight === 0);
  });

  it('unpauses during poll and a slow reader completes a large body with bounded queue', async () => {
    await boot();
    const response = await get('/large', undefined, { timeoutMs: 30_000 });
    const reader = response.body!.getReader();
    await waitFor(() => driver.stats().polling > 0);
    expect(driver.stats().polling).toBeGreaterThan(0);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(32 * 64 * 1024);
    expect(driver.stats().maxQueuedBytes).toBeGreaterThan(0);
    expect(driver.stats().maxQueuedBytes).toBeLessThan(256 * 1024);
    expect(driver.stats().bufferedBodyBytes).toBe(0);
  }, 15_000);

  it('isolates connections across proxy outlet and impersonate pool keys', async () => {
    await boot();
    const proxyA = poolOf('iso', fixture.origin, 'outlet-a');
    const proxyB = {
      ...poolOf('iso', fixture.origin, 'outlet-b'),
      key: `iso|${fixture.origin}|outlet-b|${IMPERSONATE}`,
    };
    await (await get('/iso-a', proxyA)).text();
    await (await get('/iso-b', proxyB)).text();
    expect(fixture.sessions).toBe(2);

    const chrome = poolOf('imp-a', fixture.origin);
    const other: LibcurlPoolIdentity = {
      key: `imp-b|${fixture.origin}||chrome150`,
      origin: fixture.origin,
      proxyOutlet: '',
      scope: 'imp-b',
    };
    await driver
      .submit(other, {
        caBundle: H2_CERT_PATH,
        headers: [],
        impersonate: 'chrome150',
        method: 'GET',
        timeoutMs: 10_000,
        url: fixture.url('/iso-imp'),
      })
      .then((response) => response.text());
    await (await get('/iso-chrome', chrome)).text();
    expect(fixture.sessions).toBeGreaterThanOrEqual(3);
  });

  it('merges Set-Cookie from parallel requests and does not resurrect a deleted cookie', async () => {
    await boot();
    const dir = mkdtempSync(path.join(tmpdir(), 'c3-delta-'));
    tempDirs.push(dir);
    const jar = path.join(dir, 'shared.txt');
    ensureBrowserCookieJarFile(jar);
    seedBrowserCookieJar(jar, [{ domain: 'localhost', name: 'gone', value: '1' }]);
    const identity = poolOf('delta', fixture.origin);

    const [one, two] = await Promise.all([
      get('/set-cookie?n=alpha', identity, { cookieJarPath: jar }),
      get('/set-cookie?n=beta', identity, { cookieJarPath: jar }),
    ]);
    await one.text();
    await two.text();
    await waitFor(() => {
      const names = readBrowserCookieJar(jar).map((cookie) => cookie.name);
      return names.includes('alpha') && names.includes('beta');
    });

    seedBrowserCookieJar(jar, [{ domain: 'localhost', name: 'token', value: 'old' }]);
    const slow = get('/slow-set-cookie?n=token', identity, { cookieJarPath: jar });
    const response = await slow;
    const reader = response.body!.getReader();
    await reader.read();
    replaceBrowserCookieFamily(jar, {
      cookies: [{ domain: 'localhost', name: 'token', value: 'external' }],
      domain: 'localhost',
      familyName: 'token',
    });
    await reader.read();
    await waitFor(() => driver.stats().inFlight === 0);
    expect(readBrowserCookieJar(jar).find((cookie) => cookie.name === 'token')?.value).toBe(
      'external',
    );
    expect(readBrowserCookieJar(jar).map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'token']),
    );
  });
});
