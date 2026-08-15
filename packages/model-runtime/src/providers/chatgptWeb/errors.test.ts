import { describe, expect, it } from 'vitest';

import { AgentRuntimeErrorType } from '../../types/error';
import {
  callerAbortReason,
  ChatGPTWebError,
  classifyResponseError,
  classifyTransportError,
  parseRetryAfterMs,
  toAgentRuntimeErrorType,
  TRANSPORT_UNAVAILABLE_CODE,
} from './errors';

const headers = (init: Record<string, string>) => new Headers(init);

describe('parseRetryAfterMs', () => {
  it.each([
    ['0', 0],
    ['5', 5000],
    [' 12 ', 12_000],
    ['Wed, 21 Oct 2026 07:28:00 GMT', undefined],
    [null, undefined],
  ])('parses %s', (input, expected) => {
    expect(parseRetryAfterMs(input)).toBe(expected);
  });
});

describe('classifyResponseError', () => {
  it('maps 401 to auth', () => {
    expect(classifyResponseError({ context: 'me', status: 401 }).kind).toBe('auth');
  });

  it('maps a 403 html / cf-mitigated body to cloudflare', () => {
    expect(
      classifyResponseError({
        bodyText: '<!DOCTYPE html><html>Just a moment…</html>',
        context: 'conversation',
        status: 403,
      }).kind,
    ).toBe('cloudflare');

    expect(
      classifyResponseError({
        bodyText: '{}',
        context: 'conversation',
        headers: headers({ 'cf-mitigated': 'challenge' }),
        status: 403,
      }).kind,
    ).toBe('cloudflare');
  });

  it('maps a 403 json body to permission', () => {
    expect(
      classifyResponseError({
        bodyText: '{"detail":"model not allowed"}',
        context: 'conversation',
        headers: headers({ 'content-type': 'application/json' }),
        status: 403,
      }).kind,
    ).toBe('permission');
  });

  it('maps 429 with Retry-After: 0 to rate_limit with a zero delay', () => {
    const error = classifyResponseError({
      context: 'conversation',
      headers: headers({ 'retry-after': '0' }),
      status: 429,
    });

    expect(error.kind).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(0);
  });

  it('maps 404 and everything else', () => {
    expect(classifyResponseError({ context: 'conversation', status: 404 }).kind).toBe('not_found');
    expect(classifyResponseError({ context: 'conversation', status: 500 }).kind).toBe('upstream');
  });

  it('truncates long bodies', () => {
    const error = classifyResponseError({
      bodyText: 'x'.repeat(900),
      context: 'conversation',
      status: 500,
    });
    // the sanitizer caps a diagnostic body at 500 characters
    expect(String(error.body)).toHaveLength(500);
  });

  describe('body-signalled failures (E2 §4.7)', () => {
    it.each([
      'token_expired',
      'token_invalidated',
      'token_revoked',
      'authentication token has been invalidated',
      'invalidated OAuth token',
    ])('classifies %s as auth whatever the status is', (marker) => {
      for (const status of [400, 403, 422, 500])
        expect(
          classifyResponseError({
            bodyText: `{"detail":{"code":"${marker}"}}`,
            context: 'conversation',
            status,
          }).kind,
        ).toBe('auth');
    });

    it('classifies model_cap_exceeded as model_cap', () => {
      const error = classifyResponseError({
        bodyText: '{"detail":{"code":"model_cap_exceeded","message":"upgrade"}}',
        context: 'conversation',
        status: 403,
      });

      expect(error.kind).toBe('model_cap');
    });

    it('never copies the body into the message', () => {
      const secretish = 'token_expired sk-do-not-log conversation content';
      const error = classifyResponseError({
        bodyText: secretish,
        context: 'conversation',
        status: 400,
      });

      expect(error.message).not.toContain('sk-do-not-log');
      expect(error.message).not.toContain(secretish);
      expect(error.message).toBe('conversation failed: status=400 (access token no longer valid)');
    });

    it('leaves an ordinary body alone', () => {
      expect(
        classifyResponseError({ bodyText: '{"detail":"nope"}', context: 'x', status: 500 }).kind,
      ).toBe('upstream');
    });
  });
});

describe('classifyTransportError', () => {
  it('maps abort errors to timeout and everything else to network', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyTransportError(abort, 'conversation').kind).toBe('timeout');
    expect(classifyTransportError(new TypeError('fetch failed'), 'conversation').kind).toBe(
      'network',
    );
  });

  it('passes typed errors through untouched', () => {
    const original = new ChatGPTWebError('pow', 'nope');
    expect(classifyTransportError(original, 'conversation')).toBe(original);
  });

  it.each([
    [
      'a code property',
      Object.assign(new Error('curl-impersonate is not installed'), {
        code: TRANSPORT_UNAVAILABLE_CODE,
      }),
    ],
    [
      'the class name',
      Object.assign(new Error('curl-impersonate is not installed'), {
        name: 'ChatGPTWebTransportUnavailableError',
      }),
    ],
  ])('recognises the server transport being unavailable by %s', (_label, raw) => {
    const error = classifyTransportError(raw, 'conversation');

    expect(error.kind).toBe('transport_unavailable');
    // the message is actionable and carries no secret — keep it verbatim
    expect(error.message).toBe('curl-impersonate is not installed');
    expect(error.cause).toBe(raw);
    // a downstream classifier can still see the stable code
    expect(error.code).toBe(TRANSPORT_UNAVAILABLE_CODE);
    expect(error.body).toEqual({ code: TRANSPORT_UNAVAILABLE_CODE });
    expect(toAgentRuntimeErrorType(error)).toBe(AgentRuntimeErrorType.ProviderBizError);
  });
});

describe('callerAbortReason', () => {
  it('returns undefined while the signal has not fired', () => {
    expect(callerAbortReason(undefined)).toBeUndefined();
    expect(callerAbortReason(new AbortController().signal)).toBeUndefined();
  });

  it('returns the caller reason verbatim so an AbortError survives', () => {
    const controller = new AbortController();
    controller.abort();

    const reason = callerAbortReason(controller.signal) as Error;
    expect(reason.name).toBe('AbortError');

    const custom = new AbortController();
    const sentinel = new Error('user pressed stop');
    custom.abort(sentinel);
    expect(callerAbortReason(custom.signal)).toBe(sentinel);
  });
});

describe('toAgentRuntimeErrorType', () => {
  it.each([
    ['auth', AgentRuntimeErrorType.OAuthAuthorizationExpired],
    ['rate_limit', AgentRuntimeErrorType.RateLimitExceeded],
    ['permission', AgentRuntimeErrorType.PermissionDenied],
    ['content_policy', AgentRuntimeErrorType.ProviderContentPolicyViolation],
    ['timeout', AgentRuntimeErrorType.ProviderNetworkError],
    ['cloudflare', AgentRuntimeErrorType.ProviderBizError],
    ['transport_unavailable', AgentRuntimeErrorType.ProviderBizError],
    ['upstream', AgentRuntimeErrorType.ProviderBizError],
    ['network', AgentRuntimeErrorType.ProviderBizError],
    ['pow', AgentRuntimeErrorType.ProviderBizError],
    ['arkose', AgentRuntimeErrorType.ProviderBizError],
    ['not_found', AgentRuntimeErrorType.ProviderBizError],
    ['model_cap', AgentRuntimeErrorType.ModelNotFound],
  ] as const)('maps %s', (kind, expected) => {
    expect(toAgentRuntimeErrorType(new ChatGPTWebError(kind, 'x'))).toBe(expected);
  });

  it('falls back to ProviderBizError for foreign errors', () => {
    expect(toAgentRuntimeErrorType(new Error('boom'))).toBe(AgentRuntimeErrorType.ProviderBizError);
  });
});

describe('error body sanitization', () => {
  const serialized = (error: ChatGPTWebError) =>
    JSON.stringify({ body: error.body, message: error.message });

  it('drops every field that is not on the allowlist', () => {
    const error = new ChatGPTWebError('upstream', 'file creation failed', {
      body: {
        detail: 'not allowed',
        file_id: 'file-abcdef',
        library_file_id: 'lib-1',
        status: 400,
        upload_url: 'https://blob.core.windows.net/x?sig=SECRET-SIGNATURE',
      },
    });

    expect(error.body).toEqual({ detail: 'not allowed', status: 400 });
    expect(serialized(error)).not.toContain('SECRET-SIGNATURE');
    expect(serialized(error)).not.toContain('upload_url');
  });

  it('keeps no sentinel token when the finalize payload is attached', () => {
    const error = new ChatGPTWebError('upstream', 'sentinel finalize failed', {
      body: { proofofwork: {}, so_token: 'so-SECRET', token: 'gAAAAAB-SECRET' },
    });

    expect(error.body).toBeUndefined();
    expect(serialized(error)).not.toContain('SECRET');
  });

  it('redacts urls and token-ish fields out of a raw body string', () => {
    const error = new ChatGPTWebError('upstream', 'malformed json', {
      body: '{"so_token": "so-SECRET", "download_url": "https://files.oaiusercontent.com/a?sig=S"}',
    });

    const body = String(error.body);
    expect(body).not.toContain('so-SECRET');
    expect(body).not.toContain('https://');
    expect(body).toContain('<redacted>');
  });

  it('never lets a body survive JSON.stringify of the error itself', () => {
    const error = new ChatGPTWebError('auth', 'conversation failed: status=401', {
      body: { access_token: 'ya29.SECRET', status: 401 },
      status: 401,
    });

    expect(JSON.stringify({ ...error, body: error.body })).not.toContain('SECRET');
  });

  it('leaves a plain diagnostic object intact', () => {
    expect(
      new ChatGPTWebError('upstream', 'x', { body: { code: 'boom', status: 500 } }).body,
    ).toEqual({
      code: 'boom',
      status: 500,
    });
  });
});
