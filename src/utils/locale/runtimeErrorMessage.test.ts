import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { getRuntimeErrorMessage, isPlatformLocalizedErrorType } from './runtimeErrorMessage';

const t = vi.fn((key: string) => key) as unknown as never;

describe('getRuntimeErrorMessage', () => {
  it('routes a known runtime code to the modelRuntime namespace', () => {
    expect(getRuntimeErrorMessage(t, 'InvalidProviderAPIKey')).toBe(
      'modelRuntime:InvalidProviderAPIKey',
    );
  });

  it('routes anything else — HTTP status, platform codes — to error:response.<X>', () => {
    expect(getRuntimeErrorMessage(t, 429)).toBe('response.429');
    expect(getRuntimeErrorMessage(t, PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED)).toBe(
      'response.PLATFORM_AI_PROVIDER_DISABLED',
    );
  });

  it('returns an empty string for an absent code', () => {
    expect(getRuntimeErrorMessage(t, undefined)).toBe('');
    expect(getRuntimeErrorMessage(t, '')).toBe('');
  });
});

describe('isPlatformLocalizedErrorType', () => {
  it('recognises a platform code that owns chat-facing copy', () => {
    // A provider hard-deleted mid-conversation ends the next turn with this code; the chat
    // surface must render its message instead of the raw-key / trace-id fallback.
    expect(isPlatformLocalizedErrorType(PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED)).toBe(
      true,
    );
  });

  it('does not claim localization for unregistered platform codes', () => {
    // Registering a code without its `error:response.<CODE>` copy would render a raw key —
    // unregistered codes must keep falling through to the report UI.
    expect(isPlatformLocalizedErrorType(PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND)).toBe(false);
    expect(isPlatformLocalizedErrorType('SOMETHING_ELSE')).toBe(false);
  });
});
