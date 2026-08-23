import { describe, expect, it } from 'vitest';

import {
  assembleWebSessionMint,
  attachAdoptedSessionRotation,
  rotatedRetryFields,
} from './oauthService.session.mint';
import { ChatGPTWebSessionRetryableError } from './sessionRetry';

describe('rotatedRetryFields', () => {
  it('omits chunk layout when the rotation is a single token', () => {
    expect(rotatedRetryFields({ token: 'rotated' })).toEqual({
      rotatedSessionToken: 'rotated',
    });
  });

  it('carries chunks only when the rotation arrived chunked', () => {
    expect(rotatedRetryFields({ chunks: ['a', 'b'], token: 'ab' })).toEqual({
      rotatedSessionChunks: ['a', 'b'],
      rotatedSessionToken: 'ab',
    });
  });

  it('is empty when this attempt did not rotate', () => {
    expect(rotatedRetryFields(undefined)).toEqual({});
  });
});

describe('assembleWebSessionMint', () => {
  const onInvalidSession = (): never => {
    throw new Error('invalid');
  };

  it('trims the access token and keeps presented credentials when nothing rotated', () => {
    expect(
      assembleWebSessionMint(
        {
          accessToken: '  minted  ',
          expires: '2026-01-02T00:00:00.000Z',
          user: { email: 'a@b.c' },
        },
        onInvalidSession,
        { sessionChunks: ['only'], sessionToken: 'presented' },
        undefined,
      ),
    ).toEqual({
      accessToken: 'minted',
      email: 'a@b.c',
      sessionExpiresAt: Date.parse('2026-01-02T00:00:00.000Z'),
      sessionToken: 'presented',
    });
  });

  it('copies chunk layout only when there is more than one chunk', () => {
    const minted = assembleWebSessionMint(
      { accessToken: 'tok' },
      onInvalidSession,
      { sessionToken: 'old' },
      { chunks: ['x', 'y'], token: 'xy' },
    );
    expect(minted.sessionToken).toBe('xy');
    expect(minted.sessionChunks).toEqual(['x', 'y']);
  });

  it('treats a parsed empty access token as a dead session', () => {
    expect(() =>
      assembleWebSessionMint(
        { accessToken: '  ' },
        onInvalidSession,
        { sessionToken: 'x' },
        undefined,
      ),
    ).toThrow('invalid');
  });
});

describe('attachAdoptedSessionRotation', () => {
  it('re-wraps when the loop adopted a different token than the last error', () => {
    const last = new ChatGPTWebSessionRetryableError('network', 'failed');
    const wrapped = attachAdoptedSessionRotation(last, 'adopted', ['a', 'b']);
    expect(wrapped).not.toBe(last);
    expect(wrapped.rotatedSessionToken).toBe('adopted');
    expect(wrapped.rotatedSessionChunks).toEqual(['a', 'b']);
    expect(wrapped.cause).toBe(last);
  });

  it('returns the same error when it already carries the adopted token', () => {
    const last = new ChatGPTWebSessionRetryableError('network', 'failed', {
      rotatedSessionToken: 'same',
    });
    expect(attachAdoptedSessionRotation(last, 'same', undefined)).toBe(last);
  });
});
