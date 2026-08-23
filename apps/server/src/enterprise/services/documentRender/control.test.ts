import { describe, expect, it } from 'vitest';

import { isSidecarConnectionError } from './control';

describe('isSidecarConnectionError', () => {
  it('treats known connection codes as sidecar outages', () => {
    expect(isSidecarConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isSidecarConnectionError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('treats connection-shaped messages as sidecar outages', () => {
    expect(isSidecarConnectionError(new Error('fetch failed'))).toBe(true);
    expect(isSidecarConnectionError(new Error('connect ECONNRESET'))).toBe(true);
  });

  it('walks nested cause but ignores AbortError', () => {
    const nested = new Error('fetch failed');
    (nested as Error & { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
    expect(isSidecarConnectionError(nested)).toBe(true);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isSidecarConnectionError(abort)).toBe(false);
  });

  it('does not treat processing timeout errors as sidecar outages', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const timedOut = new Error('Gotenberg convert timed out after 1000ms', { cause: abort });

    expect(isSidecarConnectionError(timedOut)).toBe(false);
    expect(
      isSidecarConnectionError(new DOMException('The operation timed out', 'TimeoutError')),
    ).toBe(false);
    expect(isSidecarConnectionError(new Error('response timeout'))).toBe(false);
  });

  it('treats a socket that dies mid-response as an outage, not a failed document', () => {
    // What undici actually throws when the sidecar sends headers and then goes away: a
    // `TypeError('terminated')` whose cause is a SocketError. No timeout code is involved — the
    // response had already started — so nothing but the code identifies it.
    const socketError = new Error('other side closed');
    (socketError as Error & { code: string }).code = 'UND_ERR_SOCKET';
    const terminated = new TypeError('terminated', { cause: socketError });

    expect(isSidecarConnectionError(terminated)).toBe(true);
  });

  it('still refuses undici response-timeout codes, which mean slow work not an outage', () => {
    // Gotenberg only sends headers once the conversion is done, so a headers timeout IS the
    // document taking too long.
    expect(isSidecarConnectionError({ code: 'UND_ERR_HEADERS_TIMEOUT' })).toBe(false);
    expect(isSidecarConnectionError({ code: 'UND_ERR_BODY_TIMEOUT' })).toBe(false);
    // A connection that never opened is an outage, though.
    expect(isSidecarConnectionError({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(true);
  });

  it('returns false for unrelated errors and non-objects', () => {
    expect(isSidecarConnectionError(null)).toBe(false);
    expect(isSidecarConnectionError('ECONNREFUSED')).toBe(false);
    expect(isSidecarConnectionError(new Error('page render failed'))).toBe(false);
  });
});
