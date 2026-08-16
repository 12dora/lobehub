import {
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  type PlatformIdentityProviderClaimPreview,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import type { JWTPayload } from 'jose';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { verifyPlatformOidcIdToken } from './idTokenVerifier';
import { DingTalkApiError } from './kinds';

export const safeJson = async (response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>) => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !response.ok ||
    response.truncated ||
    (contentType !== 'application/json' && !contentType?.endsWith('+json'))
  ) {
    throw new Error('OIDC_TEST_REMOTE_INVALID');
  }
  return response.json();
};

export const summarizeIdentityProviderClaimPreview = (
  preview: PlatformIdentityProviderClaimPreview | null,
) => {
  if (!preview) return null;
  const claims: Partial<
    Record<
      (typeof PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS)[number],
      { present: true; type: 'string' }
    >
  > = {};
  for (const claim of PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS) {
    if (preview.claims[claim] !== undefined) claims[claim] = { present: true, type: 'string' };
  }
  return {
    claims,
    // Claim VALUES never leave the server — except the DingTalk capture, which is the entire
    // point of running the test for that kind (the admin cannot type a corpId by hand) and
    // carries no credential material.
    ...(preview.dingtalk ? { dingtalk: preview.dingtalk } : {}),
    issues: preview.issues,
    valid: preview.valid,
  };
};

export const failureCategory = (error: unknown): string => {
  if (!(error instanceof Error)) return 'oidc_test_failed';
  if (error.message.includes('NOT_FOUND')) return 'not_found';
  if (error.message.includes('CALLBACK_ORIGIN')) return 'callback_origin_invalid';
  if (error.message.includes('PROVIDER_CHANGED')) return 'provider_changed';
  if (error.message.includes('CLAIM')) return 'claim_validation_failed';
  if (error instanceof DingTalkApiError) {
    return error.detail.stage === 'profile'
      ? 'dingtalk_profile_rejected'
      : 'dingtalk_token_rejected';
  }
  if (error.message.includes('CORP')) return 'corp_mismatch';
  // Order matters: OIDC_TEST_RESPONSE_ISSUER_INVALID also contains "ISSUER_INVALID".
  if (error.message.includes('RESPONSE_ISSUER')) return 'response_issuer_invalid';
  if (error.message.includes('ISSUER_INVALID')) return 'issuer_invalid';
  if (error.message.includes('NONCE') || error.message.includes('ID_TOKEN')) {
    return 'id_token_validation_failed';
  }
  if (error.message.includes('SECRET')) return 'secret_unavailable';
  if (error.message.includes('REMOTE') || error.message.includes('DISCOVERY')) {
    return 'remote_validation_failed';
  }
  return 'oidc_test_failed';
};

/**
 * Terminal error code persisted on a failed attempt, and shown to the administrator.
 *
 * DingTalk rejections additionally carry the provider's own error code as a `:suffix`
 * (`OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound`). That code is a
 * stable machine token — never the client secret, the authorization code or a token — and it is
 * the single most useful thing an administrator can see when a first real login fails.
 */
export const terminalAttemptErrorCode = (error: unknown): string => {
  if (error instanceof DingTalkApiError) {
    const base =
      error.detail.stage === 'profile'
        ? error.detail.status === 403
          ? 'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN'
          : 'OIDC_TEST_DINGTALK_PROFILE_REJECTED'
        : 'OIDC_TEST_DINGTALK_TOKEN_REJECTED';
    // Sanitized one-liner so a live smoke failure is not invisible in server logs either.
    console.error('[identityProviderTest] DingTalk rejected the request', {
      dingtalkCode: error.detail.dingtalkCode ?? 'unknown',
      stage: error.detail.stage,
      status: error.detail.status ?? 0,
    });
    return error.detail.dingtalkCode ? `${base}:${error.detail.dingtalkCode}` : base;
  }
  return error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
    ? error.message
    : 'OIDC_TEST_FAILED';
};

export const assertIdentityProviderAttemptCallbackOrigin = (
  redirectUri: string,
  effectiveOrigin: string,
): void => {
  if (new URL(redirectUri).origin !== effectiveOrigin) {
    throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  }
};

export const verifyIdentityProviderIdToken = async (input: {
  clientId: string;
  idToken: string;
  metadata: PlatformOidcDiscoveryMetadata;
  nonceHash: string;
  outbound: SafeOutboundHttpClient;
}): Promise<JWTPayload> => {
  try {
    return await verifyPlatformOidcIdToken({
      clientId: input.clientId,
      idToken: input.idToken,
      metadata: input.metadata,
      nonce: { expectedHash: input.nonceHash, mode: 'required' },
      outbound: input.outbound,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'PLATFORM_OIDC_NONCE_INVALID') {
      throw new Error('OIDC_TEST_NONCE_INVALID', { cause: error });
    }
    throw new Error('OIDC_TEST_ID_TOKEN_INVALID', { cause: error });
  }
};
