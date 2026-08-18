import { describe, expect, it, vi } from 'vitest';

import { stripTrustDeviceFromBody, stripTrustDeviceHook } from './strip-trust-device';

describe('stripTrustDeviceFromBody', () => {
  it('removes trustDevice so the stock handler never sees a truthy value', () => {
    expect(stripTrustDeviceFromBody({ code: '123456', trustDevice: true })).toEqual({
      code: '123456',
    });
    expect(stripTrustDeviceFromBody({ code: '123456' })).toEqual({ code: '123456' });
  });
});

describe('stripTrustDeviceHook', () => {
  it('matches the verify endpoints', () => {
    expect(stripTrustDeviceHook.matcher({ path: '/two-factor/verify-totp' })).toBe(true);
    expect(stripTrustDeviceHook.matcher({ path: '/two-factor/verify-backup-code' })).toBe(true);
    expect(stripTrustDeviceHook.matcher({ path: '/two-factor/verify-otp' })).toBe(true);
    expect(stripTrustDeviceHook.matcher({ path: '/sign-in/email' })).toBe(false);
  });

  it('posting trustDevice: true creates no trusted-device record and no trust cookie', () => {
    const createVerificationValue = vi.fn();
    const setSignedCookie = vi.fn();
    const body = stripTrustDeviceFromBody({ code: '123456', trustDevice: true });

    // Stock handler (`verify-two-factor.mjs:37`) only writes the record and
    // cookie when `ctx.body.trustDevice` is truthy.
    if ('trustDevice' in body && body.trustDevice) {
      createVerificationValue({ identifier: 'trust-device-x', value: 'u1' });
      setSignedCookie('trust_device', 'token');
    }

    expect(body).not.toHaveProperty('trustDevice');
    expect(createVerificationValue).not.toHaveBeenCalled();
    expect(setSignedCookie).not.toHaveBeenCalled();
  });
});
