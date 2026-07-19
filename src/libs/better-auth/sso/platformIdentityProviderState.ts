import { createHash } from 'node:crypto';

import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth/types';
import { z } from 'zod';

export const PLATFORM_OIDC_NONCE_HASH_STATE_KEY = 'platformOidcNonceHash';
export const PLATFORM_OIDC_PROVIDER_STATE_KEY = 'platformOidcProviderId';

const linkResponseSchema = z.object({ url: z.string().url() });
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
            const updated = await ctx.context.adapter.updateMany({
              model: 'verification',
              update: { value: updatedValue },
              where: [
                { field: 'id', value: verification.id },
                { field: 'identifier', value: state },
                { field: 'value', value: verification.value },
              ],
            });
            // Adapter implementations are inconsistent here: the public contract is a count,
            // while the memory and Drizzle adapters return their driver result. A numeric result
            // must still report exactly one row; the mandatory re-read below proves publication
            // for driver-shaped results.
            if (typeof updated === 'number' && updated !== 1) return failStateBinding();

            // Keep Better Auth secondary storage coherent with the CAS-published database row.
            // defineConfig enables verification.storeInDatabase so this updates both copies.
            await ctx.context.internalAdapter.updateVerificationByIdentifier(state, {
              value: updatedValue,
            });
            const published = await ctx.context.internalAdapter.findVerificationValue(state);
            if (!published || published.identifier !== state || published.value !== updatedValue) {
              return failStateBinding();
            }
          }),
          matcher: (ctx) => ctx.path === '/oauth2/link',
        },
      ],
    },
    id: 'platform-identity-provider-state',
  };
};
