/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPasskeySupported } from './passkeySupport';

const runtime = vi.hoisted(() => ({ isDesktop: false }));

vi.mock('@lobechat/const', () => ({
  get isDesktop() {
    return runtime.isDesktop;
  },
}));

const originalPublicKeyCredential = (globalThis as Record<string, unknown>).PublicKeyCredential;

const setWebAuthn = (present: boolean) => {
  if (present) (globalThis as Record<string, unknown>).PublicKeyCredential = class {};
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
};

beforeEach(() => {
  runtime.isDesktop = false;
});

afterEach(() => {
  if (originalPublicKeyCredential === undefined) setWebAuthn(false);
  else (globalThis as Record<string, unknown>).PublicKeyCredential = originalPublicKeyCredential;
});

describe('isPasskeySupported', () => {
  it('is true in a browser that exposes WebAuthn', () => {
    setWebAuthn(true);
    expect(isPasskeySupported()).toBe(true);
  });

  it('is false without window.PublicKeyCredential', () => {
    setWebAuthn(false);
    expect(isPasskeySupported()).toBe(false);
  });

  // The desktop renderer runs from `app://renderer` while the RP and accepted
  // origin are pinned to the remote APP_URL: the API is present and every
  // ceremony fails, so the probe must not call it supported.
  it('is false in the desktop renderer even though the API exists', () => {
    setWebAuthn(true);
    runtime.isDesktop = true;
    expect(isPasskeySupported()).toBe(false);
  });
});
