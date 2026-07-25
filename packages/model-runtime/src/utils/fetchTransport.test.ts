// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  bodyForHttpMethod,
  composeAbortSignal,
  FETCH_TRANSPORT_MAX_BODY_BYTES,
  normalizeFetchBody,
  responseHeadersToRecord,
} from './fetchTransport';

describe('normalizeFetchBody', () => {
  it('passes through strings, Uint8Array, Blob, FormData, and ReadableStream', async () => {
    expect(await normalizeFetchBody('hello')).toBe('hello');
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await normalizeFetchBody(bytes)).toEqual(bytes);
    expect(await normalizeFetchBody(undefined)).toBeUndefined();
    expect(await normalizeFetchBody(null)).toBeUndefined();

    const blob = new Blob(['x']);
    expect(await normalizeFetchBody(blob)).toBe(blob);

    const form = new FormData();
    form.append('a', 'b');
    expect(await normalizeFetchBody(form)).toBe(form);

    const stream = new ReadableStream();
    expect(await normalizeFetchBody(stream)).toBe(stream);
  });

  it('buffers async iterables and Buffer', async () => {
    async function* gen() {
      yield new TextEncoder().encode('ab');
      yield new TextEncoder().encode('cd');
    }
    const merged = await normalizeFetchBody(gen());
    expect(merged).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(merged as Uint8Array)).toBe('abcd');

    const buf = Buffer.from('buf');
    const fromBuf = await normalizeFetchBody(buf);
    expect(fromBuf).toEqual(new Uint8Array([98, 117, 102]));
  });

  it('rejects async bodies above the shared buffer limit', async () => {
    async function* big() {
      yield new Uint8Array(FETCH_TRANSPORT_MAX_BODY_BYTES + 1);
    }
    await expect(normalizeFetchBody(big())).rejects.toThrow(/buffer limit/);
  });
});

describe('bodyForHttpMethod', () => {
  it('suppresses bodies on GET/HEAD', () => {
    expect(bodyForHttpMethod('GET', 'x')).toBeUndefined();
    expect(bodyForHttpMethod('HEAD', 'x')).toBeUndefined();
    expect(bodyForHttpMethod('POST', 'x')).toBe('x');
  });
});

describe('composeAbortSignal', () => {
  it('aborts when the external signal aborts', () => {
    const external = new AbortController();
    const { cleanup, signal } = composeAbortSignal(external.signal);
    expect(signal.aborted).toBe(false);
    external.abort();
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('aborts on timeout and cleans up the timer', async () => {
    vi.useFakeTimers();
    try {
      const { cleanup, signal } = composeAbortSignal(undefined, 50);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(50);
      expect(signal.aborted).toBe(true);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('responseHeadersToRecord', () => {
  it('copies Headers into a plain record', () => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-a': '1' });
    expect(responseHeadersToRecord(headers)).toEqual({
      'content-type': 'application/json',
      'x-a': '1',
    });
  });
});
