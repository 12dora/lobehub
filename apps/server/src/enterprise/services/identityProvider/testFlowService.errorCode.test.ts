// @vitest-environment node
/**
 * Failure taxonomy for a safe-login / organisation-capture attempt.
 *
 * A live smoke run against a real DingTalk app showed the cost of collapsing everything into one
 * `OIDC_TEST_REMOTE_INVALID`: "wrong AppSecret", "redirect URL not registered" and "the app has
 * no contact permission" all produced the same message, none of which named the actual fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DingTalkApiError } from './kinds';
import { sanitizeAttemptErrorCode } from './testAttemptStore';
import { terminalAttemptErrorCode } from './testFlowService';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminal attempt error code', () => {
  it('separates a token-stage rejection and carries the DingTalk code', () => {
    const error = new DingTalkApiError('OIDC_TEST_DINGTALK_TOKEN_REJECTED', {
      dingtalkCode: 'invalidParameter.idOrSecret.notFound',
      stage: 'token',
      status: 400,
    });
    expect(terminalAttemptErrorCode(error)).toBe(
      'OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound',
    );
  });

  it('separates a missing contact permission from any other profile failure', () => {
    expect(
      terminalAttemptErrorCode(
        new DingTalkApiError('x', {
          dingtalkCode: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
          stage: 'profile',
          status: 403,
        }),
      ),
    ).toBe(
      'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.AccessTokenPermissionDenied',
    );
    expect(
      terminalAttemptErrorCode(new DingTalkApiError('x', { stage: 'profile', status: 500 })),
    ).toBe('OIDC_TEST_DINGTALK_PROFILE_REJECTED');
  });

  it('logs one sanitized line with the DingTalk code and nothing else', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    terminalAttemptErrorCode(
      new DingTalkApiError('x', {
        dingtalkCode: 'invalidParameter.idOrSecret.notFound',
        stage: 'token',
        status: 400,
      }),
    );
    expect(logged).toHaveBeenCalledTimes(1);
    const [, detail] = logged.mock.calls[0]!;
    expect(detail).toEqual({
      dingtalkCode: 'invalidParameter.idOrSecret.notFound',
      stage: 'token',
      status: 400,
    });
    // Only the three bounded fields are logged — no credential VALUE can ride along, because
    // the error object never carries one (the DingTalk code itself may mention "idOrSecret").
    expect(Object.keys(detail as object).toSorted()).toEqual(['dingtalkCode', 'stage', 'status']);
  });

  it('keeps the existing OIDC codes and falls back for anything unexpected', () => {
    expect(terminalAttemptErrorCode(new Error('OIDC_TEST_PROVIDER_CHANGED'))).toBe(
      'OIDC_TEST_PROVIDER_CHANGED',
    );
    expect(terminalAttemptErrorCode(new Error('boom: something leaked'))).toBe('OIDC_TEST_FAILED');
    expect(terminalAttemptErrorCode('not an error')).toBe('OIDC_TEST_FAILED');
  });
});

describe('persisted attempt error code', () => {
  it('accepts a stable code with an optional provider suffix', () => {
    expect(sanitizeAttemptErrorCode('OIDC_TEST_FAILED')).toBe('OIDC_TEST_FAILED');
    expect(
      sanitizeAttemptErrorCode(
        'OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound',
      ),
    ).toBe('OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound');
    expect(
      sanitizeAttemptErrorCode('OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.X'),
    ).toBe('OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.X');
  });

  it('discards anything free-form so no untrusted text can be persisted', () => {
    for (const value of [
      'lower_case',
      'OIDC_TEST_X:has space',
      'OIDC_TEST_X:<script>',
      'OIDC_TEST_X:',
      `OIDC_TEST_X:${'a'.repeat(65)}`,
      `${'A'.repeat(65)}`,
      'OIDC_TEST_X:1starts-with-digit',
    ]) {
      expect(sanitizeAttemptErrorCode(value), value).toBe('OIDC_TEST_FAILED');
    }
  });
});
