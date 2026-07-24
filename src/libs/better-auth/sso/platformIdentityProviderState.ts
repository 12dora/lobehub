import { createHash } from 'node:crypto';

import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth/types';
import { z } from 'zod';

import {
  enterPlatformOidcCallbackObservation,
  isPlatformOidcProviderId,
  observePlatformOidcLoginFailure,
  observePlatformOidcLoginSuccess,
  registerPlatformOidcFlow,
} from './platformIdentityProviderObservation';

export const PLATFORM_OIDC_NONCE_HASH_STATE_KEY = 'platformOidcNonceHash';
export const PLATFORM_OIDC_PROVIDER_STATE_KEY = 'platformOidcProviderId';

const linkResponseSchema = z.object({ url: z.string().url() });
const signInResponseSchema = z.object({ url: z.string().url() });
const persistedOAuthStateSchema = z
  .object({
    expiresAt: z.number(),
    oauthState: z.string(),
  })
  .passthrough();

export const createPlatformOidcNonceBinding = (nonce: string, providerId: string) => ({
  [PLATFORM_OIDC_NONCE_HASH_STATE_KEY]: createHash('sha256').update(nonce).digest('hex'),
  [PLATFORM_OIDC_PROVIDER_STATE_KEY]: providerId,
});

const failStateBinding = (): never => {
  // A regular Error is intentional: Better Auth 1.6 preserves the link handler's 200 status
  // when an after hook returns APIError. Letting this escape makes the HTTP request fail closed.
  throw new Error('PLATFORM_OIDC_STATE_BINDING_FAILED');
};

const hasSessionCookie = (headers?: Headers): boolean =>
  headers?.getSetCookie().some((cookie) => /(?:^|\s)[^=]*session_token=/.test(cookie)) ?? false;

/**
 * Better Auth creates link state before calling authorizationUrlParams. Bind the nonce to that
 * already-persisted state before the link URL can leave the server.
 */
export const platformIdentityProviderState = (
  platformProviderIds: readonly string[],
): BetterAuthPlugin => {
  const providerIds = new Set(platformProviderIds);

  return {
    hooks: {
      before: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const providerId = ctx.params?.providerId;
            if (
              typeof providerId !== 'string' ||
              !isPlatformOidcProviderId(providerId) ||
              !providerIds.has(providerId)
            ) {
              return;
            }

            const state = typeof ctx.query?.state === 'string' ? ctx.query.state : null;
            const entry = await enterPlatformOidcCallbackObservation(
              ctx.context.internalAdapter,
              state,
              providerId,
            );
            if (entry === 'mismatch') {
              throw new Error('PLATFORM_OIDC_CALLBACK_PROVIDER_MISMATCH');
            }
          }),
          matcher: (ctx) => ctx.path === '/oauth2/callback/:providerId',
        },
      ],
      after: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const providerId = ctx.body?.providerId;
            if (typeof providerId !== 'string' || !providerIds.has(providerId)) return;

            const response = linkResponseSchema.safeParse(ctx.context.returned);
            if (!response.success) return failStateBinding();

            const authorizationURL = new URL(response.data.url);
            const state = authorizationURL.searchParams.get('state');
            const nonce = authorizationURL.searchParams.get('nonce');
            if (!state || !nonce) return failStateBinding();

            const verification = await ctx.context.internalAdapter.findVerificationValue(state);
            if (!verification || verification.identifier !== state) return failStateBinding();

            let persistedState: unknown;
            try {
              persistedState = JSON.parse(verification.value);
            } catch {
              return failStateBinding();
            }
            const parsedState = persistedOAuthStateSchema.safeParse(persistedState);
            if (
              !parsedState.success ||
              parsedState.data.oauthState !== state ||
              parsedState.data.expiresAt < Date.now() ||
              verification.expiresAt.getTime() < Date.now()
            ) {
              return failStateBinding();
            }

            const updatedValue = JSON.stringify({
              ...parsedState.data,
              ...createPlatformOidcNonceBinding(nonce, providerId),
            });
            // The random state and nonce have not left this request yet, so no external caller can
            // address this verification row during publication. Use Better Auth's shared store:
            // Redis when configured, otherwise the database. The exact re-read is the publication
            // barrier and prevents a failed/no-op update from releasing the authorization URL.
            await ctx.context.internalAdapter.updateVerificationByIdentifier(state, {
              value: updatedValue,
            });
            const published = await ctx.context.internalAdapter.findVerificationValue(state);
            if (!published || published.identifier !== state || published.value !== updatedValue) {
              return failStateBinding();
            }

            await registerPlatformOidcFlow(ctx.context.internalAdapter, state, 'link', providerId);
          }),
          matcher: (ctx) => ctx.path === '/oauth2/link',
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const providerId = ctx.body?.providerId;
            if (typeof providerId !== 'string' || !providerIds.has(providerId)) return;

            const response = signInResponseSchema.safeParse(ctx.context.returned);
            if (!response.success) return;
            const state = new URL(response.data.url).searchParams.get('state');
            if (!state) return;
            await registerPlatformOidcFlow(
              ctx.context.internalAdapter,
              state,
              'sign_in',
              providerId,
            );
          }),
          matcher: (ctx) => ctx.path === '/sign-in/oauth2',
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const providerId = ctx.params?.providerId;
            if (typeof providerId !== 'string' || !providerIds.has(providerId)) return;

            const headers = ctx.context.responseHeaders;
            if (hasSessionCookie(headers) && headers?.has('location')) {
              await observePlatformOidcLoginSuccess();
              return;
            }
            // Terminal OAuth callback failure: discard ONLY this login's pending mapping
            // (flow/state-scoped). Never clear all subjects for the provider (identity/F9).
            const { discardPlatformOidcGroupRoleMappingOnLoginFailure } =
              await import('./platformIdentityProvider');
            const flowId = typeof ctx.query?.state === 'string' ? ctx.query.state : undefined;
            discardPlatformOidcGroupRoleMappingOnLoginFailure({
              flowId,
              providerKey: providerId,
            });
            await observePlatformOidcLoginFailure('unexpected');
          }),
          matcher: (ctx) => ctx.path === '/oauth2/callback/:providerId',
        },
      ],
    },
    id: 'platform-identity-provider-state',
  };
};
