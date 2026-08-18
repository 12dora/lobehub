import { isDesktop } from '@lobechat/const';

/**
 * Whether a WebAuthn ceremony can actually complete in this runtime.
 *
 * `window.PublicKeyCredential` alone is not enough. The desktop renderer is served
 * from `app://renderer`, while the passkey relying party (RP ID) and the only
 * accepted origin are pinned to the remote `APP_URL`. Chromium will not run a
 * ceremony for a remote RP from that origin, so the API is present and every call
 * fails — at the browser, or at the server's origin check.
 *
 * Probing the API and calling it "supported" therefore offers the user a button
 * that can only fail. Fold the runtime into the capability check itself, so no
 * call site has to remember a second condition.
 */
export const isPasskeySupported = (): boolean =>
  !isDesktop && typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
