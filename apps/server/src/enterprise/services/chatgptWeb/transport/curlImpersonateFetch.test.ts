import { getEventListeners } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCurlImpersonateFetch } from './curlImpersonateFetch';
import { ChatGPTWebTransportUnavailableError } from './errors';

/**
 * A fake `curl-impersonate` that mirrors the REAL wiring this transport depends on:
 *
 * - the config arrives on STDIN (`--config -`) and carries the url, method, proxy and
 *   every header;
 * - the request body is read back from the temp file named by `data-binary = "@path"`;
 * - the header block goes to STDOUT (`--dump-header -`) immediately AHEAD of the body,
 *   exactly like curl — HTTP/2 status lines with no reason phrase, 1xx and CONNECT
 *   pre-blocks included.
 *
 * The previous fake used inherited fds 3/4, which is precisely why the `/dev/fd` recipe
 * passed every test and then failed on Linux, where those fds are socketpairs.
 */
const FAKE_BIN_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const argv = process.argv.slice(2);

const out = (text) => fs.writeSync(1, text);
// Real curl writes the header dump to the same stdout, before any body byte.
const dump = out;

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  if (argv.indexOf('--config') === -1 || argv[argv.indexOf('--config') + 1] !== '-') {
    fs.writeSync(2, "curl: cannot read config from '-'");
    process.exit(26);
  }

  // curl config grammar: name = "value", with \" and \\ escapes.
  const configText = await readStdin();
  const config = [];
  for (const line of configText.split('\n')) {
    const match = /^([\w-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!match) continue;
    config.push([match[1], match[2].replace(/\\(.)/g, (_, c) => (c === 't' ? '\t' : c))]);
  }
  const first = (name) => {
    const entry = config.find(([key]) => key === name);
    return entry ? entry[1] : undefined;
  };
  const headers = config.filter(([key]) => key === 'header').map(([, value]) => value);
  const url = first('url') || '';
  const method = first('request') || 'GET';
  const proxy = first('proxy');
  const cacert = first('cacert');
  const dataBinary = first('data-binary');

  let body = '';
  let bodyPath;
  let bodyMode;
  if (dataBinary) {
    if (dataBinary[0] !== '@') {
      fs.writeSync(2, 'curl: (26) expected an @file data-binary parameter');
      process.exit(26);
    }
    bodyPath = dataBinary.slice(1);
    bodyMode = fs.statSync(bodyPath).mode & 0o777;
    body = fs.readFileSync(bodyPath, 'utf8');
  }

  const path = new URL(url).pathname;

  if (path === '/prefail') {
    fs.writeSync(2, 'curl: (6) Could not resolve host: example.invalid');
    process.exit(6);
  }

  if (path === '/json200') {
    dump('HTTP/2 200 \r\ncontent-type: application/json\r\nx-test: yes\r\ncontent-length: 15\r\n\r\n');
    out('{"ok":true}');
    return;
  }

  if (path === '/json401') {
    dump('HTTP/2 401 \r\ncontent-type: application/json\r\n\r\n');
    out('{"detail":"nope"}');
    return;
  }

  if (path === '/html403') {
    dump('HTTP/2 403 \r\ncontent-type: text/html\r\ncf-mitigated: challenge\r\n\r\n');
    out('<html>challenge</html>');
    return;
  }

  if (path === '/continue') {
    dump('HTTP/1.1 100 Continue\r\n\r\n');
    await sleep(20);
    dump('HTTP/2 200 \r\ncontent-type: application/json\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n');
    out('{"continued":true}');
    return;
  }

  if (path === '/sse') {
    dump('HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n');
    out('data: one\n\n');
    await sleep(200);
    out('data: two\n\n');
    return;
  }

  if (path === '/echo') {
    dump('HTTP/2 200 \r\ncontent-type: application/json\r\n\r\n');
    out(JSON.stringify({ argv, body, bodyMode, bodyPath, cacert, headers, method, proxy, url }));
    return;
  }

  if (path === '/split') {
    // The header terminator straddles two writes AND the second one already carries body
    // bytes — the exact shape that broke a naive "headers, then body" reader.
    out('HTTP/2 200 \r\ncontent-type: application/json\r\nx-split: yes\r\n\r');
    await sleep(30);
    out('\n{"split":true}');
    return;
  }

  if (path === '/connect') {
    // What a forward proxy writes into the dump before the origin's own head.
    dump('HTTP/1.1 200 Connection established\r\nProxy-Agent: squid/5.7\r\n\r\n');
    dump('HTTP/2 204 \r\nx-origin: yes\r\n\r\n');
    return;
  }

  if (path === '/flood') {
    dump('HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n');
    // Far more than the stream's high-water mark: the transport must pause stdout and
    // then kill this process when nobody drains it.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 64; i += 1) out(chunk);
    setInterval(() => {}, 1000);
    return;
  }

  if (path === '/midfail') {
    dump('HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n');
    out('data: partial\n\n');
    await sleep(20);
    fs.writeSync(2, 'curl: (18) transfer closed with outstanding read data remaining');
    process.exit(18);
  }

  if (path === '/hang') {
    dump('HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n');
    out('data: one\n\n');
    setInterval(() => {}, 1000);
    return;
  }

  dump('HTTP/2 404 \r\n\r\n');
  out('not found');
};

main();
`;

let dir: string;
let bin: string;
let impersonateFetch: typeof fetch;

const readAll = async (response: Response) => await response.text();

/** Where the transport stages request bodies; used to prove nothing is left behind. */
const TEMP_BODY_DIR = join(tmpdir(), 'aihub-chatgptweb');

const listTempBodies = (): string[] => {
  try {
    return readdirSync(TEMP_BODY_DIR);
  } catch {
    return [];
  }
};

/** The temp file is unlinked on the child's `close`, which lands after the response. */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'curl-impersonate-test-'));
  bin = join(dir, 'curl-impersonate');
  writeFileSync(bin, FAKE_BIN_SOURCE);
  chmodSync(bin, 0o755);
  impersonateFetch = createCurlImpersonateFetch({ binaryPath: bin });
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('createCurlImpersonateFetch', () => {
  it('returns a JSON 200 response with parsed headers', async () => {
    const response = await impersonateFetch('https://chatgpt.com/json200');

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-test')).toBe('yes');
    // Body was decoded by curl; a stale content-length would lie about it.
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.url).toBe('https://chatgpt.com/json200');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('surfaces a 401 as a normal response, not a throw', async () => {
    const response = await impersonateFetch('https://chatgpt.com/json401');

    expect(response.status).toBe(401);
    expect(response.ok).toBe(false);
    await expect(response.json()).resolves.toEqual({ detail: 'nope' });
  });

  it('surfaces a 403 HTML challenge body', async () => {
    const response = await impersonateFetch('https://chatgpt.com/html403');

    expect(response.status).toBe(403);
    expect(response.headers.get('cf-mitigated')).toBe('challenge');
    await expect(readAll(response)).resolves.toContain('challenge');
  });

  it('parses the LAST header block and skips 1xx pre-blocks', async () => {
    const response = await impersonateFetch('https://chatgpt.com/continue');

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    await expect(response.json()).resolves.toEqual({ continued: true });
  });

  /**
   * The regression that ships with `--dump-header -`: head and body now travel on the SAME
   * pipe, so the terminating blank line can be cut in half by a chunk boundary and the
   * first body bytes can ride in the chunk that completes it.
   */
  it('splits head from body when the terminator straddles two chunks', async () => {
    const response = await impersonateFetch('https://chatgpt.com/split');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-split')).toBe('yes');
    // The body must be exactly the bytes after the blank line — no leading newline, and
    // no header text bleeding into it.
    await expect(response.text()).resolves.toBe('{"split":true}');
  });

  it('streams the body incrementally instead of buffering the whole response', async () => {
    const response = await impersonateFetch('https://chatgpt.com/sse');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const start = Date.now();
    const first = await reader.read();
    const firstAt = Date.now() - start;
    const second = await reader.read();
    const secondAt = Date.now() - start;

    expect(decoder.decode(first.value)).toBe('data: one\n\n');
    expect(decoder.decode(second.value)).toBe('data: two\n\n');
    expect(firstAt).toBeLessThan(150);
    expect(secondAt).toBeGreaterThanOrEqual(150);
    await reader.cancel();
  });

  it('passes method, headers and body through to the child process', async () => {
    const response = await impersonateFetch('https://chatgpt.com/echo', {
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json', 'oai-device-id': 'device-1' },
      method: 'POST',
    });

    const echoed = (await response.json()) as {
      body: string;
      headers: string[];
      method: string;
      url: string;
    };

    expect(echoed.method).toBe('POST');
    expect(echoed.url).toBe('https://chatgpt.com/echo');
    expect(echoed.body).toBe('{"hello":"world"}');
    expect(echoed.headers).toContain('oai-device-id: device-1');
    expect(echoed.headers).toContain('content-type: application/json');
  });

  it('accepts Uint8Array and URLSearchParams bodies', async () => {
    const bytes = await impersonateFetch('https://chatgpt.com/echo', {
      body: new TextEncoder().encode('raw-bytes'),
      method: 'POST',
    });
    expect(((await bytes.json()) as { body: string }).body).toBe('raw-bytes');

    const form = await impersonateFetch('https://chatgpt.com/echo', {
      body: new URLSearchParams({ grant_type: 'refresh_token' }),
      method: 'POST',
    });
    const echoed = (await form.json()) as { body: string; headers: string[] };
    expect(echoed.body).toBe('grant_type=refresh_token');
    expect(echoed.headers).toContain(
      'content-type: application/x-www-form-urlencoded;charset=UTF-8',
    );
  });

  it('rejects FormData bodies with an explicit error', async () => {
    const form = new FormData();
    form.append('file', 'x');

    await expect(
      impersonateFetch('https://chatgpt.com/echo', { body: form, method: 'POST' }),
    ).rejects.toThrow(/does not support FormData/);
  });

  it('rejects header values containing CR/LF', async () => {
    // Header-injection guard; `sanitizeRequestHeaders` is the transport's own backstop
    // (see request.test.ts) for header bags that are not a validating `Headers`.
    await expect(
      impersonateFetch('https://chatgpt.com/json200', {
        headers: { 'x-evil': 'a\r\nx-injected: 1' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects with an undici-shaped TypeError when curl fails before the headers', async () => {
    await expect(impersonateFetch('https://chatgpt.com/prefail')).rejects.toThrow(
      /^fetch failed: curl\(6\): curl: \(6\)/,
    );
  });

  it('errors the BODY (not the promise) when curl fails mid-stream', async () => {
    const response = await impersonateFetch('https://chatgpt.com/midfail');
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: partial\n\n');
    await expect(reader.read()).rejects.toThrow(/fetch failed: curl\(18\)/);
  });

  it('aborts the request and errors the body stream', async () => {
    const controller = new AbortController();
    const response = await impersonateFetch('https://chatgpt.com/hang', {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(
      impersonateFetch('https://chatgpt.com/json200', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws an actionable error when the binary is missing', async () => {
    const missing = createCurlImpersonateFetch({ binaryPath: join(dir, 'does-not-exist') });

    await expect(missing('https://chatgpt.com/json200')).rejects.toBeInstanceOf(
      ChatGPTWebTransportUnavailableError,
    );
  });

  it('skips a proxy CONNECT block and settles on the origin head', async () => {
    const response = await impersonateFetch('https://chatgpt.com/connect');

    expect(response.status).toBe(204);
    expect(response.headers.get('x-origin')).toBe('yes');
    expect(response.headers.get('proxy-agent')).toBeNull();
  });

  it('kills the child when nobody consumes a back-pressured body', async () => {
    const impatient = createCurlImpersonateFetch({ binaryPath: bin, bodyStallTimeoutMs: 150 });
    const response = await impatient('https://chatgpt.com/flood');
    const reader = response.body!.getReader();

    // Read once so the queue fills, then stop reading entirely.
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(reader.read()).rejects.toThrow(/was not consumed/);
  }, 10_000);
});

/**
 * The request body cannot travel on stdin any more — the config owns it — so it is staged
 * in a file. That file holds whatever the user is sending to ChatGPT, so its permissions
 * and its lifetime are part of the transport's contract.
 */
describe('staged request body file', () => {
  it('is 0600, readable by the child, and removed once the request completes', async () => {
    const response = await impersonateFetch('https://chatgpt.com/echo', {
      body: new TextEncoder().encode('staged-bytes'),
      method: 'POST',
    });
    const echoed = (await response.json()) as { body: string; bodyMode: number; bodyPath: string };

    expect(echoed.body).toBe('staged-bytes');
    // Owner read/write only, while the child still had it open.
    expect(echoed.bodyMode).toBe(0o600);
    expect(echoed.bodyPath.startsWith(TEMP_BODY_DIR)).toBe(true);

    await waitFor(() => !existsSync(echoed.bodyPath));
  });

  it('is removed when curl fails before the headers', async () => {
    const before = new Set(listTempBodies());

    await expect(
      impersonateFetch('https://chatgpt.com/prefail', { body: 'doomed', method: 'POST' }),
    ).rejects.toThrow(/fetch failed/);

    await waitFor(() => listTempBodies().every((entry) => before.has(entry)));
  });

  it('is removed when the request is aborted mid-stream', async () => {
    const before = new Set(listTempBodies());
    const controller = new AbortController();
    const response = await impersonateFetch('https://chatgpt.com/hang', {
      body: 'streaming',
      method: 'POST',
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => listTempBodies().every((entry) => before.has(entry)));
  });
});

/**
 * argv is world-readable (`ps`, `/proc/<pid>/cmdline`, crash reports). Everything that can
 * identify or authenticate the caller therefore travels on the config that goes in
 * through stdin.
 */
describe('secret handling', () => {
  const SECRET_TOKEN = 'Bearer secret-access-token-value';
  const SIGNED_URL = 'https://files.oaiusercontent.com/echo?sig=SIGNATURE-SECRET&se=2026-01-01';

  it('keeps url, proxy and headers out of argv and passes them on fd 4', async () => {
    const proxied = createCurlImpersonateFetch({
      binaryPath: bin,
      proxyUrl: 'http://proxyuser:proxypass@proxy.internal:8080',
    });

    const response = await proxied(SIGNED_URL, {
      headers: { authorization: SECRET_TOKEN },
    });
    const echoed = (await response.json()) as {
      argv: string[];
      cacert?: string;
      headers: string[];
      method: string;
      proxy?: string;
      url: string;
    };

    // The child really did read them — from the config file, not the command line.
    expect(echoed.url).toBe(SIGNED_URL);
    expect(echoed.proxy).toBe('http://proxyuser:proxypass@proxy.internal:8080');
    expect(echoed.headers).toContain(`authorization: ${SECRET_TOKEN}`);

    const argv = echoed.argv.join(' ');
    expect(argv).not.toContain('secret-access-token-value');
    expect(argv).not.toContain('SIGNATURE-SECRET');
    expect(argv).not.toContain('proxypass');
    expect(argv).not.toContain('oaiusercontent.com');
    expect(argv).not.toContain('authorization');
    // Config on stdin, header dump on stdout: no inherited /dev/fd descriptor survives.
    expect(argv).not.toContain('/dev/fd');
    expect(echoed.argv.join(' ')).toContain('--config -');
    expect(echoed.argv.join(' ')).toContain('--dump-header -');
    expect(echoed.argv).toContain('--suppress-connect-headers');
    // No redirect following, ever.
    expect(echoed.argv).not.toContain('-L');
    expect(echoed.argv).not.toContain('--location');
  });

  it('keeps the staged body path out of argv too', async () => {
    const response = await impersonateFetch('https://chatgpt.com/echo', {
      body: JSON.stringify({ secret: 'body-secret-value' }),
      method: 'POST',
    });
    const echoed = (await response.json()) as { argv: string[]; body: string; bodyPath: string };

    expect(echoed.body).toBe('{"secret":"body-secret-value"}');
    expect(echoed.bodyPath).toContain('aihub-chatgptweb');
    expect(echoed.argv.join(' ')).not.toContain('aihub-chatgptweb');
    expect(echoed.argv.join(' ')).not.toContain('body-secret-value');
    expect(echoed.argv).not.toContain('--data-binary');
  });

  /**
   * `--disable` only suppresses `.curlrc` when it is the FIRST argument — curl parses the
   * config file before it reaches a later occurrence. A host config could otherwise switch
   * on `location` (redirects carry the Authorization header past the hostname allowlist),
   * append a second `url`, or write the body to a file of its choosing.
   */
  it('passes --disable as argv[0] so no .curlrc is ever read', async () => {
    const response = await impersonateFetch('https://chatgpt.com/echo');
    const echoed = (await response.json()) as { argv: string[] };

    expect(echoed.argv[0]).toBe('--disable');
  });

  it('omits data-binary entirely when there is no request body', async () => {
    const response = await impersonateFetch('https://chatgpt.com/echo');
    const echoed = (await response.json()) as {
      argv: string[];
      bodyPath?: string;
      method: string;
    };

    // Neither on the command line nor in the config: a bare `data-binary` would turn this
    // GET into a zero-length form POST.
    expect(echoed.argv).not.toContain('--data-binary');
    expect(echoed.bodyPath).toBeUndefined();
    expect(echoed.method).toBe('GET');
  });

  it('escapes quotes and backslashes in header values', async () => {
    const value = String.raw`a"b\c`;
    const response = await impersonateFetch('https://chatgpt.com/echo', {
      headers: { 'x-quoted': value },
    });
    const echoed = (await response.json()) as { headers: string[] };

    expect(echoed.headers).toContain(`x-quoted: ${value}`);
  });

  it('removes the abort listener once the request is over', async () => {
    const controller = new AbortController();

    for (let i = 0; i < 3; i += 1) {
      const response = await impersonateFetch('https://chatgpt.com/json200', {
        signal: controller.signal,
      });
      await response.text();
    }

    // Node keeps the process-level listener count observable; a leak here would grow with
    // every request made on a long-lived conversation signal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

/**
 * Real network smoke: only runs when an operator points the env var at a real binary.
 * chatgpt.com answers a bogus bearer with 401 through an impersonated fingerprint and
 * with 403 (`cf-mitigated: challenge`) through anything else — so a 401 IS the assertion
 * that the impersonation still works.
 */
describe.skipIf(!process.env.CHATGPT_WEB_CURL_IMPERSONATE_BIN)('real curl-impersonate', () => {
  it('reaches chatgpt.com/backend-api/me and gets 401 (not 403)', async () => {
    const realFetch = createCurlImpersonateFetch();
    const response = await realFetch('https://chatgpt.com/backend-api/me', {
      headers: {
        'Authorization': 'Bearer bogus-token-for-smoke',
        'OAI-Language': 'en-US',
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('cf-mitigated')).toBeNull();
    await response.text();
  }, 30_000);

  /**
   * The other half of the recipe: a request BODY, which now reaches curl through
   * `data-binary = "@tempfile"` inside the stdin config. The origin answers this endpoint
   * with 401/429/500 depending on the anonymous device state — anything but a Cloudflare
   * 403 means the body was posted through a working impersonated connection.
   */
  it('posts a JSON body from the staged temp file', async () => {
    const realFetch = createCurlImpersonateFetch();
    const response = await realFetch(
      'https://chatgpt.com/backend-anon/sentinel/chat-requirements',
      {
        body: JSON.stringify({ p: 'smoke' }),
        headers: {
          'Content-Type': 'application/json',
          'OAI-Language': 'en-US',
        },
        method: 'POST',
      },
    );

    expect(response.status).not.toBe(403);
    expect(response.headers.get('cf-mitigated')).toBeNull();
    await response.text();
  }, 30_000);

  /**
   * The real parser, not our fake: only curl itself can prove that `.curlrc` was not read.
   * The poisoned config asks for redirect following, a SECOND url (whose body would be
   * concatenated onto ours) and an `output` file that would steal the response body from
   * stdout entirely — the file's absence is the crisp signal that none of it applied.
   */
  it('ignores a poisoned .curlrc', async () => {
    const home = mkdtempSync(join(tmpdir(), 'curl-impersonate-curlrc-'));
    const stolenBody = join(home, 'stolen-body.bin');
    writeFileSync(
      join(home, '.curlrc'),
      ['location', 'url = "https://example.com/"', `output = "${stolenBody}"`, ''].join('\n'),
    );
    const previousCurlHome = process.env.CURL_HOME;
    process.env.CURL_HOME = home;

    try {
      const realFetch = createCurlImpersonateFetch();
      const response = await realFetch('https://chatgpt.com/backend-api/me', {
        headers: {
          'Authorization': 'Bearer bogus-token-for-smoke',
          'OAI-Language': 'en-US',
        },
      });
      const text = await response.text();

      expect(response.status).toBe(401);
      // `output = …` would have redirected the body out of stdout.
      expect(existsSync(stolenBody)).toBe(false);
      // A honoured second `url` appends that transfer's body to the same stdout.
      expect(text).not.toContain('Example Domain');
    } finally {
      if (previousCurlHome === undefined) delete process.env.CURL_HOME;
      else process.env.CURL_HOME = previousCurlHome;
      rmSync(home, { force: true, recursive: true });
    }
  }, 30_000);
});
