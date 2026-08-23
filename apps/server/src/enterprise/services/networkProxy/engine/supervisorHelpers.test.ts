// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { issueCodeForStartFailure, memberAlive } from './supervisorHelpers';

describe('memberAlive', () => {
  it('is false when the proxy is missing', () => {
    expect(memberAlive(undefined)).toBe(false);
  });

  it('is true when alive is set', () => {
    expect(memberAlive({ alive: true })).toBe(true);
  });

  it('falls back to a positive last history delay', () => {
    expect(memberAlive({ history: [{ delay: 0 }, { delay: 12 }] })).toBe(true);
    expect(memberAlive({ history: [{ delay: 0 }] })).toBe(false);
  });
});

describe('issueCodeForStartFailure', () => {
  it('maps any post-spawn failure to start_timeout', () => {
    expect(issueCodeForStartFailure(new Error('EADDRINUSE'), true)).toBe('start_timeout');
  });

  it('maps port allocation errors before spawn', () => {
    expect(issueCodeForStartFailure(new Error('EADDRINUSE: port taken'), false)).toBe(
      'ports_unavailable',
    );
    // The one this repo actually raises, and the only case the word matcher carries on its own:
    // no address code, just the word. `ports.ts` throws it verbatim when the OS hands back 0.
    expect(issueCodeForStartFailure(new Error('failed to allocate loopback port'), false)).toBe(
      'ports_unavailable',
    );
    expect(issueCodeForStartFailure(new Error('ports unavailable'), false)).toBe(
      'ports_unavailable',
    );
  });

  it('keeps unsupported-platform errors out of port allocation', () => {
    try {
      throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.UNSUPPORTED_PLATFORM);
    } catch (error) {
      expect(issueCodeForStartFailure(error, false)).toBe('unsupported_platform');
    }
  });

  it('maps TimeoutError to start_timeout', () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    expect(issueCodeForStartFailure(error, false)).toBe('start_timeout');
  });

  it('keeps the mapped engine issue otherwise', () => {
    try {
      throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
    } catch (error) {
      expect(issueCodeForStartFailure(error, false)).toBe('artifact_mismatch');
    }
  });
});
