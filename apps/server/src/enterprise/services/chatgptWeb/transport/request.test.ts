import { describe, expect, it } from 'vitest';

import { ChatGPTWebTransportPolicyError } from './errors';
import {
  normalizeRequest,
  readRequestBody,
  sanitizeRequestHeaders,
  validateRequestMethod,
  validateRequestUrl,
} from './request';

/** A header bag that does NOT validate its values, unlike the real `Headers`. */
const looseHeaders = (entries: [string, string][]): Headers =>
  ({
    forEach: (callback: (value: string, name: string) => void) => {
      for (const [name, value] of entries) callback(value, name);
    },
    has: () => false,
    set: () => undefined,
  }) as unknown as Headers;

describe('sanitizeRequestHeaders', () => {
  it('drops headers curl computes itself', () => {
    const entries = sanitizeRequestHeaders(
      new Headers({ 'accept-encoding': 'gzip', 'content-length': '12', 'x-keep': 'yes' }),
    );

    expect(entries).toEqual([['x-keep', 'yes']]);
  });

  it('rejects CR/LF in a header value', () => {
    expect(() => sanitizeRequestHeaders(looseHeaders([['x-evil', 'a\r\nx-injected: 1']]))).toThrow(
      /CR\/LF is not allowed/,
    );
  });

  it('rejects CR/LF in a header name', () => {
    expect(() => sanitizeRequestHeaders(looseHeaders([['x\r\nevil', 'ok']]))).toThrow(
      /CR\/LF is not allowed/,
    );
  });

  it('rejects header names outside the token charset', () => {
    expect(() => sanitizeRequestHeaders(looseHeaders([['x evil', 'ok']]))).toThrow(
      /Invalid header name/,
    );
  });
});

describe('readRequestBody', () => {
  const decode = (bytes?: Uint8Array) => (bytes ? new TextDecoder().decode(bytes) : undefined);

  it('returns undefined for an absent body', async () => {
    expect(await readRequestBody(undefined, new Headers())).toBeUndefined();
    expect(await readRequestBody(null, new Headers())).toBeUndefined();
  });

  it('encodes strings, typed arrays and ArrayBuffers', async () => {
    expect(decode(await readRequestBody('hello', new Headers()))).toBe('hello');
    expect(decode(await readRequestBody(new TextEncoder().encode('bytes'), new Headers()))).toBe(
      'bytes',
    );
    expect(
      decode(await readRequestBody(new TextEncoder().encode('buffer').buffer, new Headers())),
    ).toBe('buffer');
  });

  it('sets a form content-type for URLSearchParams only when absent', async () => {
    const headers = new Headers();
    expect(decode(await readRequestBody(new URLSearchParams({ a: '1' }), headers))).toBe('a=1');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8');

    const explicit = new Headers({ 'content-type': 'text/plain' });
    await readRequestBody(new URLSearchParams({ a: '1' }), explicit);
    expect(explicit.get('content-type')).toBe('text/plain');
  });

  it('drains a ReadableStream body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.enqueue(new TextEncoder().encode('b'));
        controller.close();
      },
    });

    expect(decode(await readRequestBody(stream, new Headers()))).toBe('ab');
  });

  it('rejects FormData', async () => {
    const form = new FormData();
    form.append('x', '1');

    await expect(readRequestBody(form, new Headers())).rejects.toThrow(/does not support FormData/);
  });

  it('cancels an endless stream instead of buffering past the cap', async () => {
    let cancelled = false;
    const megabyte = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (controller) => {
        controller.enqueue(megabyte);
      },
    });

    await expect(readRequestBody(stream, new Headers())).rejects.toThrow(
      ChatGPTWebTransportPolicyError,
    );
    expect(cancelled).toBe(true);
  }, 30_000);

  it('rejects an already-aborted signal without draining the stream', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled = true;
        controller.enqueue(new TextEncoder().encode('x'));
      },
    });

    await expect(readRequestBody(stream, new Headers(), AbortSignal.abort())).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(pulled).toBe(false);
  });

  it('cancels the reader and rejects when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (streamController) => {
        streamController.enqueue(new TextEncoder().encode('chunk'));
        controller.abort();
      },
    });

    await expect(readRequestBody(stream, new Headers(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(cancelled).toBe(true);
  });
});

describe('validateRequestUrl', () => {
  it.each([
    'https://chatgpt.com/backend-api/me',
    'https://auth.openai.com/oauth/token',
    'https://sentinel.openai.com/backend-api/sentinel/req',
    'https://files.oaiusercontent.com/file-abc?sig=x',
    'https://cdn.oaistatic.com/asset.js',
    'https://openaiuploads.blob.core.windows.net/container/file?sig=x',
  ])('allows %s', (url) => {
    expect(validateRequestUrl(url, {})).toBe(url);
  });

  it.each([
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a gopher scheme', 'gopher://chatgpt.com/'],
    ['plain http by default', 'http://chatgpt.com/x'],
    ['embedded credentials', 'https://user:pass@chatgpt.com/x'],
    ['an unlisted host', 'https://evil.example.com/x'],
    ['a lookalike host', 'https://chatgpt.com.evil.example/x'],
    ['loopback', 'https://127.0.0.1/x'],
    ['the metadata service', 'https://169.254.169.254/latest/meta-data/'],
    ['a relative url', '/backend-api/me'],
  ])('rejects %s', (_label, url) => {
    expect(() => validateRequestUrl(url, {})).toThrow(ChatGPTWebTransportPolicyError);
  });

  it('rejects control characters before the WHATWG parser can strip them', () => {
    expect(() => validateRequestUrl('https://chatgpt.com/x\r\nHost: evil', {})).toThrow(
      /control characters/,
    );
  });

  it('allows plain http only behind the explicit test switch', () => {
    expect(
      validateRequestUrl('http://chatgpt.com/x', { CHATGPT_WEB_ALLOW_INSECURE_HTTP: '1' }),
    ).toBe('http://chatgpt.com/x');
  });

  it('extends the host policy from the environment', () => {
    const env = { CHATGPT_WEB_ALLOWED_HOSTS: 'mirror.internal, .proxy.test ' };

    expect(validateRequestUrl('https://a.mirror.internal/x', env)).toBe(
      'https://a.mirror.internal/x',
    );
    expect(validateRequestUrl('https://proxy.test/x', env)).toBe('https://proxy.test/x');
    expect(() => validateRequestUrl('https://other.test/x', env)).toThrow(
      ChatGPTWebTransportPolicyError,
    );
  });
});

describe('validateRequestMethod', () => {
  it('upper-cases a valid token', () => {
    expect(validateRequestMethod('patch')).toBe('PATCH');
  });

  it.each(['GET /x HTTP/1.1', 'GET\r\nHost: evil', 'POST POST', ''])('rejects %j', (method) => {
    expect(() => validateRequestMethod(method)).toThrow(ChatGPTWebTransportPolicyError);
  });
});

describe('normalizeRequest', () => {
  it('normalizes a plain url + init', async () => {
    const controller = new AbortController();
    const request = await normalizeRequest('https://chatgpt.com/backend-api/me', {
      headers: { 'oai-language': 'en-US' },
      method: 'get',
      signal: controller.signal,
    });

    expect(request).toMatchObject({
      headers: [['oai-language', 'en-US']],
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/me',
    });
    expect(request.body).toBeUndefined();
    expect(request.signal).toBe(controller.signal);
  });

  it('accepts a URL instance', async () => {
    const request = await normalizeRequest(new URL('https://chatgpt.com/a?b=1'));
    expect(request.url).toBe('https://chatgpt.com/a?b=1');
  });

  it('rejects a disallowed destination before anything is spawned', async () => {
    await expect(normalizeRequest('https://evil.example.com/x')).rejects.toBeInstanceOf(
      ChatGPTWebTransportPolicyError,
    );
  });

  it('rejects an already-aborted signal', async () => {
    await expect(
      normalizeRequest('https://chatgpt.com/x', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads method, headers and body from a Request instance', async () => {
    const source = new Request('https://chatgpt.com/backend-api/conversation', {
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    const request = await normalizeRequest(source);

    expect(request.method).toBe('POST');
    expect(new TextDecoder().decode(request.body)).toBe('{"a":1}');
    expect(request.headers).toContainEqual(['content-type', 'application/json']);
  });

  /**
   * A streaming `Request` used to be drained with `arrayBuffer()`, which has neither the
   * 64 MiB cap nor the abort wiring: an endless source stayed stuck after abort and an
   * oversized one could exhaust the server. It now takes the same bounded path as a raw
   * `ReadableStream` body.
   */
  it('caps an oversized streaming Request body instead of buffering it', async () => {
    let cancelled = false;
    const megabyte = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (controller) => {
        controller.enqueue(megabyte);
      },
    });
    const source = new Request('https://chatgpt.com/backend-api/conversation', {
      body,
      // Node requires half-duplex to be declared for a stream body.
      duplex: 'half',
      method: 'POST',
    } as RequestInit);

    await expect(normalizeRequest(source)).rejects.toBeInstanceOf(ChatGPTWebTransportPolicyError);
    expect(cancelled).toBe(true);
  }, 30_000);

  it('cancels an endless streaming Request body when the signal aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (streamController) => {
        streamController.enqueue(new TextEncoder().encode('chunk'));
        controller.abort();
      },
    });
    const source = new Request('https://chatgpt.com/backend-api/conversation', {
      body,
      duplex: 'half',
      method: 'POST',
      signal: controller.signal,
    } as RequestInit);

    await expect(normalizeRequest(source)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
