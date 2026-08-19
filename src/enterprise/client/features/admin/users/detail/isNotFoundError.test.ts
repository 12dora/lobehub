import { describe, expect, it } from 'vitest';

import { isNotFoundError } from './isNotFoundError';

describe('isNotFoundError', () => {
  it('returns true for message + data.code PLATFORM_NOT_FOUND', () => {
    expect(
      isNotFoundError({
        data: { code: 'PLATFORM_NOT_FOUND' },
        message: 'PLATFORM_NOT_FOUND',
      }),
    ).toBe(true);
  });

  it('returns true for nested data.errorData.code', () => {
    expect(
      isNotFoundError({
        data: { errorData: { code: 'PLATFORM_NOT_FOUND' } },
      }),
    ).toBe(true);
  });

  it('returns true when the message matches the PLATFORM_NOT_FOUND regex', () => {
    expect(isNotFoundError({ message: 'load failed: PLATFORM_NOT_FOUND for user' })).toBe(true);
  });

  it('returns true when mapEnterpriseError maps the payload to PLATFORM_NOT_FOUND', () => {
    // cause.data is walked by mapEnterpriseError, not by the local dataCode fallback
    expect(
      isNotFoundError({
        cause: { data: { code: 'PLATFORM_NOT_FOUND' } },
      }),
    ).toBe(true);
  });

  it('returns false for a generic network Error (must stay on the generic-error UI)', () => {
    expect(isNotFoundError(new Error('Network down'))).toBe(false);
  });

  it('returns false for null / undefined / false', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError(false)).toBe(false);
  });
});
