import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { readProviderFailureBody, resolveFetchFailureMessage } from './providerFailureCopy';

/** Stand-in for a bound `t`: echoes the key, exactly like an unresolved namespace lookup. */
const echo = ((key: string) => key) as unknown as TFunction<'modelProvider'>;
const echoSetting = echo as unknown as TFunction<'setting'>;

const trpcError = (errorData: Record<string, unknown>) =>
  Object.assign(new Error(String(errorData.message ?? errorData.code)), { data: { errorData } });

describe('readProviderFailureBody', () => {
  it('reads the stable code and details off a tRPC enterprise body', () => {
    const body = readProviderFailureBody(
      trpcError({
        code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
        details: { errorCategory: 'auth', errorType: 'OAuthAuthorizationExpired' },
        message: 'connection_failed_shared_account_expired',
      }),
    );

    expect(body.message).toBe('connection_failed_shared_account_expired');
    expect(body.details?.errorType).toBe('OAuthAuthorizationExpired');
  });

  it('exposes the stable code itself — the shared reader carries it', () => {
    const body = readProviderFailureBody(trpcError({ code: 'MANAGED_RESOURCE_BY_PLATFORM' }));

    expect(body.code).toBe('MANAGED_RESOURCE_BY_PLATFORM');
  });

  it('still reads a body that carries no enterprise code', () => {
    // `cannot_enumerate` rides on PLATFORM_INVALID_INPUT, but older payloads carry details only.
    const body = readProviderFailureBody(trpcError({ details: { reason: 'cannot_enumerate' } }));

    expect(body.details?.reason).toBe('cannot_enumerate');
  });

  it('reads nothing off a plain rejection', () => {
    expect(readProviderFailureBody(new Error('boom'))).toEqual({
      details: undefined,
      message: undefined,
    });
  });
});

describe('resolveFetchFailureMessage', () => {
  it('keeps the upstream prose — it is the most actionable thing on the toast', () => {
    expect(
      resolveFetchFailureMessage(
        new Error('Cursor Agent transport unavailable'),
        echo,
        echoSetting,
      ),
    ).toBe('Cursor Agent transport unavailable');
  });

  it('never renders a stable code, even when it arrives as the exception text', () => {
    expect(
      resolveFetchFailureMessage(new Error('MANAGED_RESOURCE_BY_PLATFORM'), echo, echoSetting),
    ).toBe('providerModels.list.fetcher.errorFallback');
  });

  it('translates a classified connection failure into the checker copy', () => {
    expect(
      resolveFetchFailureMessage(
        trpcError({
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { errorCategory: 'auth' },
          message: 'connection_failed_auth',
        }),
        echo,
        echoSetting,
      ),
    ).toBe('llm.checker.reason.connectionFailedAuth');
  });

  it('falls back to localized copy for a server body it cannot classify', () => {
    expect(
      resolveFetchFailureMessage(
        trpcError({
          code: 'MANAGED_RESOURCE_BY_PLATFORM',
          message: 'MANAGED_RESOURCE_BY_PLATFORM',
        }),
        echo,
        echoSetting,
      ),
    ).toBe('providerModels.list.fetcher.errorFallback');
  });
});
