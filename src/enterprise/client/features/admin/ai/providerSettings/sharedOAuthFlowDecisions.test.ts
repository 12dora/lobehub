import { describe, expect, it } from 'vitest';

import { decideDevicePollTick, decidePastePollResult } from './sharedOAuthFlowDecisions';

describe('decideDevicePollTick', () => {
  it.each([
    {
      expected: { delaySeconds: 5, kind: 'retry' },
      input: { consecutiveFailures: 0, intervalSeconds: 5, threw: true },
      name: 'first transient failure retries at the current interval',
    },
    {
      expected: { delaySeconds: 5, kind: 'retry' },
      input: { consecutiveFailures: 1, intervalSeconds: 5, threw: true },
      name: 'second transient failure still retries',
    },
    {
      expected: { kind: 'fail', reason: 'authError' },
      input: { consecutiveFailures: 2, intervalSeconds: 5, threw: true },
      name: 'third consecutive transient failure is terminal',
    },
    {
      expected: { kind: 'ignore' },
      input: { consecutiveFailures: 2, intervalSeconds: 5, stale: true, threw: true },
      name: 'a stale throw does not spend the failure budget',
    },
    {
      expected: { kind: 'staleSuccess' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { revision: 2, status: 'success' },
        stale: true,
        threw: false,
      },
      name: 'a success that lands after cancel is a stale success',
    },
    {
      expected: { kind: 'ignore' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { revision: null, status: 'pending' },
        stale: true,
        threw: false,
      },
      name: 'a non-success that lands after cancel is ignored',
    },
    {
      expected: { kind: 'success', revision: 2 },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { revision: 2, status: 'success' },
        threw: false,
      },
      name: 'success reports the applied revision',
    },
    {
      expected: { kind: 'success', revision: null },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { status: 'success' },
        threw: false,
      },
      name: 'success without a revision is still success',
    },
    {
      expected: { kind: 'fail', reason: 'providerStoreFailed' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { error: 'provider_store_failed', revision: null, status: 'denied' },
        threw: false,
      },
      name: 'denied + provider_store_failed is a store failure, not a denial',
    },
    {
      expected: { kind: 'fail', reason: 'denied' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { error: null, revision: null, status: 'denied' },
        threw: false,
      },
      name: 'plain denial stays a denial',
    },
    {
      expected: { kind: 'fail', reason: 'denied' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { error: 'something_else', revision: null, status: 'denied' },
        threw: false,
      },
      name: 'denied with an unknown error is still a denial',
    },
    {
      expected: { kind: 'fail', reason: 'codeExpired' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { error: 'expired', revision: null, status: 'error' },
        threw: false,
      },
      name: 'error + expired is a spent grant',
    },
    {
      expected: { kind: 'fail', reason: 'authError' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { error: 'boom', revision: null, status: 'error' },
        threw: false,
      },
      name: 'error without expired is a terminal auth failure',
    },
    {
      expected: { kind: 'fail', reason: 'codeExpired' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { revision: null, status: 'expired' },
        threw: false,
      },
      name: 'expired status is a spent grant',
    },
    {
      expected: { delaySeconds: 10, kind: 'retry' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        result: { revision: null, status: 'slow_down' },
        threw: false,
      },
      name: 'slow_down backs off by 5s',
    },
    {
      expected: { delaySeconds: 5, kind: 'retry' },
      input: {
        consecutiveFailures: 2,
        intervalSeconds: 5,
        result: { revision: null, status: 'pending' },
        threw: false,
      },
      name: 'pending retries at the current interval',
    },
    {
      expected: { delaySeconds: 5, kind: 'retry' },
      input: {
        consecutiveFailures: 0,
        intervalSeconds: 5,
        threw: false,
      },
      name: 'a missing result retries at the current interval',
    },
  ] as const)('$name', ({ expected, input }) => {
    expect(decideDevicePollTick(input)).toEqual(expected);
  });
});

describe('decidePastePollResult', () => {
  it.each([
    {
      expected: { kind: 'success', revision: 2 },
      input: {
        result: { revision: 2, status: 'success' },
        source: 'callback' as const,
      },
      name: 'success reports the applied revision',
    },
    {
      expected: { kind: 'expired' },
      input: {
        result: { error: 'expired', revision: null, status: 'error' },
        source: 'callback' as const,
      },
      name: 'expired literal is a terminal envelope',
    },
    {
      expected: { kind: 'expired' },
      input: {
        result: { revision: null, status: 'expired' },
        source: 'callback' as const,
      },
      name: 'expired status without a mapped error is still terminal',
    },
    {
      expected: { error: 'invalidCallback', kind: 'fieldError', source: 'callback' },
      input: {
        result: { error: 'invalid_callback', revision: null, status: 'error' },
        source: 'callback' as const,
      },
      name: 'invalid_callback maps onto the callback field',
    },
    {
      expected: { error: 'stateMismatch', kind: 'fieldError', source: 'callback' },
      input: {
        result: { error: 'state_mismatch', revision: null, status: 'error' },
        source: 'callback' as const,
      },
      name: 'state_mismatch maps onto the callback field',
    },
    {
      expected: { error: 'exchangeFailed', kind: 'fieldError', source: 'callback' },
      input: {
        result: { error: 'exchange_failed', revision: null, status: 'error' },
        source: 'callback' as const,
      },
      name: 'exchange_failed maps onto the submitted field',
    },
    {
      expected: { error: 'accessTokenInvalid', kind: 'fieldError', source: 'token' },
      input: {
        result: { error: 'access_token_invalid', revision: null, status: 'error' },
        source: 'token' as const,
      },
      name: 'access_token_invalid maps onto the token field',
    },
    {
      expected: { error: 'sessionInvalid', kind: 'fieldError', source: 'token' },
      input: {
        result: { error: 'session_invalid', revision: null, status: 'error' },
        source: 'token' as const,
      },
      name: 'session_invalid maps onto the token field',
    },
    {
      expected: { error: 'tokenNotWeb', kind: 'fieldError', source: 'token' },
      input: {
        result: { error: 'token_not_web', revision: null, status: 'error' },
        source: 'token' as const,
      },
      name: 'token_not_web maps onto the token field',
    },
    {
      expected: { error: 'authError', kind: 'fieldError', source: 'callback' },
      input: {
        result: { error: 'something_new', revision: null, status: 'error' },
        source: 'callback' as const,
      },
      name: 'an unknown literal is a recoverable authError on the submitted field',
    },
    {
      expected: { error: 'authError', kind: 'fieldError', source: 'token' },
      input: {
        result: { error: 'something_new', revision: null, status: 'error' },
        source: 'token' as const,
      },
      name: 'an unknown literal keeps the token source',
    },
    {
      expected: { error: 'invalidCallback', kind: 'fieldError', source: 'callback' },
      input: {
        result: { error: 'invalid_callback', revision: null, status: 'expired' },
        source: 'callback' as const,
      },
      name: 'a mapped literal wins over an expired status',
    },
    {
      expected: { kind: 'networkError', source: 'callback' },
      input: { source: 'callback' as const, threw: true },
      name: 'a thrown redeem is a network error on the callback field',
    },
    {
      expected: { kind: 'networkError', source: 'token' },
      input: { source: 'token' as const, threw: true },
      name: 'a thrown redeem is a network error on the token field',
    },
  ] as const)('$name', ({ expected, input }) => {
    expect(decidePastePollResult(input)).toEqual(expected);
  });
});
