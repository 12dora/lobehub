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

  it('returns false for unrelated errors and non-objects', () => {
    expect(isSidecarConnectionError(null)).toBe(false);
    expect(isSidecarConnectionError('ECONNREFUSED')).toBe(false);
    expect(isSidecarConnectionError(new Error('page render failed'))).toBe(false);
  });
});
