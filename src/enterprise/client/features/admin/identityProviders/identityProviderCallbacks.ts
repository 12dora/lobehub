import type { PlatformIdentityProviderType } from '@lobechat/types';

/** Callback URL templates returned by `admin.identityProviders.getCallbackUrls`. */
export interface IdentityProviderCallbackUrls {
  dingtalkProduction: string;
  production: string;
  test: string;
}

/**
 * The production redirect URL an administrator must register depends on the kind: DingTalk sends
 * `authCode` instead of the OAuth 2.0 `code`, so it registers the shim path that rewrites it.
 * `{providerKey}` is substituted as soon as the key is known, so the value can be copied as-is.
 */
export const resolveIdentityProviderCallbackUrls = (
  callbacks: IdentityProviderCallbackUrls | undefined,
  draft: { providerKey: string; type: PlatformIdentityProviderType },
): { production: string | null; test: string | null } => {
  if (!callbacks) return { production: null, test: null };
  const template = draft.type === 'dingtalk' ? callbacks.dingtalkProduction : callbacks.production;
  const providerKey = draft.providerKey.trim();
  return {
    production: providerKey ? template.replaceAll('{providerKey}', providerKey) : template,
    test: callbacks.test,
  };
};

export class IdentityProviderTestPopupBlockedError extends Error {
  constructor() {
    super('IDENTITY_PROVIDER_TEST_POPUP_BLOCKED');
    this.name = 'IdentityProviderTestPopupBlockedError';
  }
}

/** Posted by the isolated test-callback page to `window.opener` when the attempt finishes. */
export const IDENTITY_PROVIDER_TEST_MESSAGE_TYPE = 'aihub-identity-provider-test';

export const openIdentityProviderTestPopup = async <Result extends { authorizationUrl: string }>(
  start: () => Promise<Result>,
  openWindow: typeof window.open = window.open.bind(window),
): Promise<{ popup: Window; result: Result }> => {
  const popup = openWindow('about:blank', 'oidc-provider-test', 'width=520,height=720');
  if (!popup) throw new IdentityProviderTestPopupBlockedError();
  try {
    const result = await start();
    popup.location.assign(result.authorizationUrl);
    return { popup, result };
  } catch (error) {
    if (!popup.closed) popup.close();
    throw error;
  }
};
