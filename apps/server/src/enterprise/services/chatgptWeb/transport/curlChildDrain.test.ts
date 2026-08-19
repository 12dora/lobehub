import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { COOKIE_JAR_HEADER, registerContextCookieJar, resetCookieJars } from './cookieJar';
import {
  createCurlImpersonateFetch,
  drainCurlImpersonateChildren,
  resetChatGPTWebFetch,
  trackedCurlChildCountForTests,
} from './curlImpersonateFetch';

afterEach(async () => {
  resetChatGPTWebFetch();
  await Promise.resolve(resetCookieJars());
});

describe('CLI child drain', () => {
  it('kills an in-flight CLI child when the context scope is drained', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-drain-'));
    const stub = path.join(dir, 'sleep-curl');
    writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(stub, 0o755);

    const digest = 'ef'.repeat(32);
    registerContextCookieJar(digest, path.join(dir, 'jar.txt'), 'pool-cli-child');
    process.env.CHATGPT_WEB_ALLOWED_HOSTS = 'chatgpt.com';
    const fetchImpl = createCurlImpersonateFetch({ binaryPath: stub });
    const pending = fetchImpl('https://chatgpt.com/', {
      headers: { [COOKIE_JAR_HEADER]: digest },
    });
    await vi.waitFor(() => expect(trackedCurlChildCountForTests()).toBeGreaterThan(0));

    await drainCurlImpersonateChildren('pool-cli-child');
    await expect(pending).rejects.toBeDefined();
  });
});
