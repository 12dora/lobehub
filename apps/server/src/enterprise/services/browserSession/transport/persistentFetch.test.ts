import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { COOKIE_JAR_HEADER } from '../../chatgptWeb/transport/cookieJar';
import { createCurlImpersonateFetch } from '../../chatgptWeb/transport/curlImpersonateFetch';
import { resolveCurlImpersonateBinary } from '../../chatgptWeb/transport/resolveBinary';
import { H2_CERT_PATH, startH2Fixture } from './h2Fixture';
import { probeLibcurlImpersonate } from './libcurlFfi';
import { createLibcurlMultiDriver } from './multiDriver';
import { CONTEXT_GONE_ERROR, createPersistentImpersonateFetch } from './persistentFetch';

const probe = probeLibcurlImpersonate();
if (!probe.available) {
  console.warn(`skipping persistentFetch tests: ${probe.reason}`);
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../..',
);
const resolveCliBinary = (): string | undefined => {
  try {
    return resolveCurlImpersonateBinary({ cwd: REPO_ROOT });
  } catch {
    const fallback = path.join(REPO_ROOT, '.cache', 'curl-impersonate', 'curl-impersonate');
    return existsSync(fallback) ? fallback : undefined;
  }
};

const CLI_BINARY = resolveCliBinary();
const IMPERSONATE = 'chrome136';

const flattenHeaders = (headers: Record<string, unknown>): string[] => {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) pairs.push(`${name.toLowerCase()}=${entry}`);
    } else {
      pairs.push(`${name.toLowerCase()}=${String(value)}`);
    }
  }
  return pairs.sort();
};

describe.skipIf(!probe.available)('createPersistentImpersonateFetch', () => {
  afterEach(() => {
    delete process.env.CHATGPT_WEB_ALLOWED_HOSTS;
  });

  it('routes a context-scoped request through the persistent driver', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    const fixture = await startH2Fixture();
    const driver = createLibcurlMultiDriver();
    try {
      const fetchImpl = createPersistentImpersonateFetch({
        caBundle: H2_CERT_PATH,
        defaultPoolScope: 'persistent-scope',
        defaultTimeoutMs: 10_000,
        driver,
        impersonate: IMPERSONATE,
      });
      const first = await fetchImpl(fixture.url('/json'));
      const second = await fetchImpl(fixture.url('/json'));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await first.text();
      await second.text();
      expect(fixture.sessions).toBe(1);
    } finally {
      await driver.drainAll();
      await fixture.close();
    }
  });

  it('rejects a context jar header whose mapping disappeared instead of using unscoped', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    const fixture = await startH2Fixture();
    const driver = createLibcurlMultiDriver();
    try {
      const fetchImpl = createPersistentImpersonateFetch({
        caBundle: H2_CERT_PATH,
        defaultPoolScope: 'should-not-use',
        driver,
        impersonate: IMPERSONATE,
        resolvePool: () => undefined,
      });
      await expect(
        fetchImpl(fixture.url('/json'), { headers: { [COOKIE_JAR_HEADER]: 'stale-digest' } }),
      ).rejects.toThrow(CONTEXT_GONE_ERROR);
    } finally {
      await driver.drainAll();
      await fixture.close();
    }
  });

  it('rejects when a valid mapping is removed during body normalization', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    const fixture = await startH2Fixture();
    const driver = createLibcurlMultiDriver();
    try {
      const mapping = new Map([
        ['live-digest', { cookieJarPath: '/tmp/c3-gone.jar', poolScope: 'scope-live' }],
      ]);
      let releaseBody: ((chunk: Uint8Array) => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = (chunk) => {
            controller.enqueue(chunk);
            controller.close();
          };
        },
      });
      const fetchImpl = createPersistentImpersonateFetch({
        caBundle: H2_CERT_PATH,
        defaultPoolScope: 'unscoped-must-not-win',
        driver,
        impersonate: IMPERSONATE,
        resolvePool: (key) => mapping.get(key),
      });
      const pending = fetchImpl(fixture.url('/echo/gone'), {
        body,
        headers: { [COOKIE_JAR_HEADER]: 'live-digest' },
        method: 'POST',
      });
      mapping.delete('live-digest');
      releaseBody?.(new TextEncoder().encode('{}'));
      await expect(pending).rejects.toThrow(CONTEXT_GONE_ERROR);
      expect(driver.stats().pools).toBe(0);
    } finally {
      await driver.drainAll();
      await fixture.close();
    }
  });
});

describe.skipIf(!probe.available || !CLI_BINARY)('header parity with curl-impersonate CLI', () => {
  if (!CLI_BINARY) {
    console.warn('skipping header parity: curl-impersonate CLI binary is not in .cache');
  }

  afterEach(() => {
    delete process.env.CHATGPT_WEB_ALLOWED_HOSTS;
  });

  it('sends the same request headers as the CLI transport, including empty-as-drop', async () => {
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'localhost';
    const fixture = await startH2Fixture();
    const driver = createLibcurlMultiDriver();
    try {
      // Empty Sec-Fetch-User is the runtime drop signal (headers.ts#dropNavigationOnly),
      // rendered as `Name:` on both transports — not `Name;`.
      const headers = {
        'Accept': 'application/json',
        'Sec-Fetch-User': '',
        'X-Custom': 'yes',
      };
      const cli = createCurlImpersonateFetch({
        binaryPath: CLI_BINARY,
        caBundle: H2_CERT_PATH,
        impersonate: IMPERSONATE,
      });
      const persistent = createPersistentImpersonateFetch({
        caBundle: H2_CERT_PATH,
        defaultPoolScope: 'parity',
        defaultTimeoutMs: 15_000,
        driver,
        impersonate: IMPERSONATE,
      });

      const path = '/parity';
      const cliResponse = await cli(fixture.url(path), { headers });
      await cliResponse.text();
      const persistentResponse = await persistent(fixture.url(path), { headers });
      await persistentResponse.text();

      expect(fixture.captured).toHaveLength(2);
      const cliHeaders = flattenHeaders(fixture.captured[0]!.headers as Record<string, unknown>);
      const persistentHeaders = flattenHeaders(
        fixture.captured[1]!.headers as Record<string, unknown>,
      );
      expect(persistentHeaders).toEqual(cliHeaders);
      expect(
        cliHeaders.some((pair) => pair.startsWith('sec-fetch-user=') && !pair.endsWith('=')),
      ).toBe(false);
    } finally {
      await driver.drainAll();
      await fixture.close();
    }
  });
});
