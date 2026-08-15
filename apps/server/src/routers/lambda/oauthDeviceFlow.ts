import { TRPCError } from '@trpc/server';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  getProviderOAuthGrantFlow,
  isProviderAccessTokenPasteAllowed,
  isRotatingRefreshOAuthProvider,
} from 'model-bank/modelProviders';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AiProviderModel } from '@/database/models/aiProvider';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import type { AiProviderOAuthPollError } from '@/server/enterprise/contracts/aiProviderOAuth';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import {
  type ChatGPTWebConnection,
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  parsePasteEnvelope,
} from '@/server/enterprise/services/chatgptWeb/oauthService';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { parseJwtExpiry } from '@/server/services/oauthDeviceFlow';
import {
  getOAuthService,
  GithubCopilotOAuthService,
} from '@/server/services/oauthDeviceFlow/providers/githubCopilot';

const oauthProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();

  return opts.next({
    ctx: {
      // Workspace-scoped exactly like the sibling aiProvider router: without the workspace
      // id every OAuth connect/status/revoke would read and write the caller's PERSONAL
      // provider row while they act inside a workspace.
      aiProviderModel: new AiProviderModel(ctx.serverDB, ctx.userId, ctx.workspaceId ?? undefined),
      gateKeeper,
    },
  });
});
const oauthWriteProcedure = oauthProcedure.use(withScopedPermission('ai_provider:update'));

/**
 * Get OAuth Device Flow config for a provider
 */
function getOAuthConfig(providerId: string) {
  const provider = DEFAULT_MODEL_PROVIDER_LIST.find((p) => p.id === providerId);

  if (!provider?.settings?.oauthDeviceFlow) {
    return null;
  }

  return provider.settings.oauthDeviceFlow;
}

/**
 * Authorization-code + PKCE where the user pastes the callback URL back (the redirect
 * URI belongs to the provider and cannot point at this deployment). There is nothing to
 * poll: `pollAuthStatus` stays `pending` until the paste arrives.
 */
const isPasteFlow = (providerId: string) =>
  getProviderOAuthGrantFlow(providerId) === 'authorization_code_paste';

/**
 * K2 vault leaves. EVERY optional leaf moves as a unit with the credential it describes:
 * `updateConfig` merges `{...existing, ...new}` and `JSON.stringify` drops the explicit
 * `undefined`s, so a reconnect that provides no refresh token (pasted access token) really
 * does remove the previous one instead of leaving a foreign account's grant behind it.
 */
const connectionKeyVaults = (connection: ChatGPTWebConnection) => ({
  oauthAccessToken: connection.accessToken,
  oauthAccountEmail: connection.email,
  oauthAccountId: connection.accountId,
  oauthDeviceId: connection.deviceId,
  /**
   * Connect time is the keepalive anchor for a grant that has never been refreshed, so
   * the forced 3-day renewal is measured from here rather than from the first refresh.
   * The paired error stamp is cleared: a reconnect must not inherit the dead grant's
   * backoff.
   */
  oauthLastRefreshAt: String(Date.now()),
  oauthLastRefreshErrorAt: undefined,
  oauthRefreshToken: connection.refreshToken,
  oauthTokenExpiresAt: connection.expiresAt ? String(connection.expiresAt) : undefined,
});

export const oauthDeviceFlowRouter = router({
  /**
   * Get current OAuth authentication status for a provider
   */
  getAuthStatus: oauthProcedure
    .input(z.object({ providerId: z.string() }))
    .query(async ({ input, ctx }) => {
      const providerDetail = await ctx.aiProviderModel.getAiProviderById(
        input.providerId,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );

      if (!providerDetail?.keyVaults) {
        return { status: 'PENDING' };
      }

      const keyVaults = providerDetail.keyVaults as Record<string, any>;

      // Check for OAuth token
      if (keyVaults.oauthAccessToken) {
        return {
          avatarUrl: keyVaults.githubAvatarUrl as string | undefined,
          /**
           * A credential without a refresh grant (pasted access token) expires for good.
           * The card must say so instead of silently going dead mid-conversation.
           */
          canRefresh:
            Boolean(keyVaults.oauthRefreshToken) &&
            isRotatingRefreshOAuthProvider(input.providerId),
          email: keyVaults.oauthAccountEmail as string | undefined,
          expiresAt: keyVaults.oauthTokenExpiresAt || keyVaults.bearerTokenExpiresAt,
          status: 'ACTIVE',
          username: keyVaults.githubUsername as string | undefined,
        };
      }

      return { status: 'PENDING' };
    }),

  /**
   * Initiate OAuth Device Flow - request a device code
   */
  initiateDeviceCode: oauthWriteProcedure
    .use(withManagedResourceGuard('oauthDeviceFlow.initiateDeviceCode'))
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input }) => {
      const config = getOAuthConfig(input.providerId);

      if (!config) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Provider ${input.providerId} does not support OAuth Device Flow`,
        });
      }

      const service = getOAuthService(input.providerId);
      const deviceCodeResponse = await service.initiateDeviceCode(config);

      return {
        /** Paste flow: an opaque client-held envelope, never persisted server-side. */
        allowAccessTokenPaste: isProviderAccessTokenPasteAllowed(input.providerId),
        deviceCode: deviceCodeResponse.deviceCode,
        expiresIn: deviceCodeResponse.expiresIn,
        flow: getProviderOAuthGrantFlow(input.providerId),
        interval: deviceCodeResponse.interval,
        userCode: deviceCodeResponse.userCode,
        verificationUri: deviceCodeResponse.verificationUri,
        verificationUriComplete: deviceCodeResponse.verificationUriComplete,
      };
    }),

  /**
   * Poll for authorization status and exchange tokens if authorized
   */
  pollAuthStatus: oauthWriteProcedure
    .use(withManagedResourceGuard('oauthDeviceFlow.pollAuthStatus'))
    .input(
      z.object({
        /** Paste flow only: the pasted redirect URL, or the bare authorization code. */
        accessToken: z.string().max(8192).optional(),
        callbackUrl: z.string().max(4096).optional(),
        // Same bound as the admin contract: for the paste flow this is a client-held
        // envelope, and an unbounded string would be an unbounded server-side JSON parse.
        deviceCode: z.string().max(8192),
        providerId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const config = getOAuthConfig(input.providerId);

      if (!config) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Provider ${input.providerId} does not support OAuth Device Flow`,
        });
      }

      const service = getOAuthService(input.providerId);

      if (isPasteFlow(input.providerId)) {
        if (!(service instanceof ChatGPTWebOAuthService)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} does not support the paste flow`,
          });
        }

        // Nothing pasted yet: the client polls this the same way it polls a device code,
        // but the server does no network work at all until the user acts.
        if (!input.callbackUrl && !input.accessToken) return { status: 'pending' as const };

        if (input.accessToken && !isProviderAccessTokenPasteAllowed(input.providerId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} does not accept a pasted access token`,
          });
        }

        let connection;
        try {
          // Both branches REQUIRE a live envelope: it carries the PKCE verifier for the
          // code exchange and the device id the authorize call was made with. A malformed
          // or stale one is reported (`invalid_callback` / `expired`) rather than silently
          // minting a fresh device id, which would break the sentinel handshake the stored
          // `oai-device-id` is supposed to keep stable.
          const envelope = parsePasteEnvelope(input.deviceCode);
          connection = input.callbackUrl
            ? await service.exchangeCallback(config, input.deviceCode, input.callbackUrl)
            : await service.verifyAccessToken(input.accessToken!, envelope.deviceId);
        } catch (error) {
          // Stable machine-readable codes only: provider prose (and the pasted callback,
          // which carries a live authorization code) must never reach the client or logs.
          if (error instanceof ChatGPTWebOAuthError) {
            // Typed against the SHARED poll-error union: the connect UI maps these literals
            // to its own copy, so a code that is not in the contract is a silent
            // server/client drift rather than a compile error.
            const code: AiProviderOAuthPollError = error.code;
            return { error: code, status: 'error' as const };
          }
          throw error;
        }

        await ctx.aiProviderModel.updateConfig(
          input.providerId,
          { keyVaults: connectionKeyVaults(connection) },
          ctx.gateKeeper.encrypt,
          KeyVaultsGateKeeper.getUserKeyVaults,
        );

        return { status: 'success' as const };
      }

      // For GitHub Copilot, use the specialized service
      if (input.providerId === 'githubcopilot' && service instanceof GithubCopilotOAuthService) {
        try {
          const tokens = await service.completeAuthFlow(config, input.deviceCode);

          if (!tokens) {
            // Still pending
            const pollResult = await service.pollForToken(config, input.deviceCode);
            return { status: pollResult.status };
          }

          // Save tokens and user info to keyVaults
          await ctx.aiProviderModel.updateConfig(
            input.providerId,
            {
              keyVaults: {
                bearerToken: tokens.bearerToken,
                bearerTokenExpiresAt: String(tokens.bearerTokenExpiresAt),
                githubAvatarUrl: tokens.userInfo.avatarUrl,
                githubUsername: tokens.userInfo.username,
                oauthAccessToken: tokens.oauthAccessToken,
              },
            },
            ctx.gateKeeper.encrypt,
            KeyVaultsGateKeeper.getUserKeyVaults,
          );

          return { status: 'success' as const };
        } catch {
          // Probably still pending or error
          const pollResult = await service.pollForToken(config, input.deviceCode);
          return { status: pollResult.status };
        }
      }

      // Generic OAuth flow
      const pollResult = await service.pollForToken(config, input.deviceCode);

      if (pollResult.status === 'success' && pollResult.tokens) {
        // Expiry: prefer the explicit expires_in, fall back to the JWT exp
        // claim — some providers (e.g. xAI) don't always return expires_in.
        const expiresAt = pollResult.tokens.expiresIn
          ? Date.now() + pollResult.tokens.expiresIn * 1000
          : parseJwtExpiry(pollResult.tokens.accessToken);

        // Save tokens to keyVaults
        await ctx.aiProviderModel.updateConfig(
          input.providerId,
          {
            keyVaults: {
              oauthAccountId: pollResult.tokens.accountId,
              oauthAccessToken: pollResult.tokens.accessToken,
              // Keepalive anchor / backoff reset — see `connectionKeyVaults`.
              oauthLastRefreshAt: String(Date.now()),
              oauthLastRefreshErrorAt: undefined,
              oauthRefreshToken: pollResult.tokens.refreshToken,
              oauthTokenExpiresAt: expiresAt ? String(expiresAt) : undefined,
            },
          },
          ctx.gateKeeper.encrypt,
          KeyVaultsGateKeeper.getUserKeyVaults,
        );
      }

      return { status: pollResult.status };
    }),

  /**
   * Revoke OAuth authorization for a provider
   */
  revokeAuth: oauthWriteProcedure
    .use(withManagedResourceGuard('oauthDeviceFlow.revokeAuth'))
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Clear OAuth tokens and user info from keyVaults
      await ctx.aiProviderModel.updateConfig(
        input.providerId,
        {
          keyVaults: {
            bearerToken: undefined,
            bearerTokenExpiresAt: undefined,
            githubAvatarUrl: undefined,
            githubUsername: undefined,
            oauthAccountEmail: undefined,
            oauthAccountId: undefined,
            oauthAccessToken: undefined,
            oauthDeviceId: undefined,
            oauthLastRefreshAt: undefined,
            oauthLastRefreshErrorAt: undefined,
            oauthRefreshToken: undefined,
            oauthTokenExpiresAt: undefined,
          },
        },
        ctx.gateKeeper.encrypt,
        KeyVaultsGateKeeper.getUserKeyVaults,
      );

      return { success: true };
    }),
});

export type OAuthDeviceFlowRouter = typeof oauthDeviceFlowRouter;
