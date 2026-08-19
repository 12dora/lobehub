import { isChatGPTWebSessionToken } from '@lobechat/utils/chatgptWebPaste';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  getProviderOAuthGrantFlow,
  isProviderAccessTokenPasteAllowed,
  isProviderWebSessionOnly,
  isRotatingRefreshOAuthProvider,
} from 'model-bank/modelProviders';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AiProviderModel } from '@/database/models/aiProvider';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  type AiProviderOAuthPollError,
  chatgptWebDeviceIdSchema,
  chatgptWebSessionTokenSchema,
} from '@/server/enterprise/contracts/aiProviderOAuth';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import { PlatformBrowserProfileService } from '@/server/enterprise/services/browserProfile';
import {
  type ChatGPTWebConnection,
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  parsePasteEnvelope,
  resolveChatGPTWebConnectDeviceId,
  wipeChatGPTWebCookieJar,
} from '@/server/enterprise/services/chatgptWeb/oauthService';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  type OAuthRenewalKind,
  parseJwtExpiry,
  parseOAuthRenewalKind,
} from '@/server/services/oauthDeviceFlow';
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
 * Stored label first, credential shape as the fallback for pre-existing connections.
 * An unrecognised stored value is treated as ABSENT (`parseOAuthRenewalKind`) so the shape
 * fallback still runs, exactly as the refresh path does with the same leaf.
 */
const resolveRenewalKind = (stored: unknown, refreshCredential: string): OAuthRenewalKind =>
  parseOAuthRenewalKind(stored) ??
  (isChatGPTWebSessionToken(refreshCredential) ? 'web_session' : 'oauth');

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
   * How the stored renewal credential must be spent (`oauth` vs the chatgpt.com
   * `web_session` cookie). Moves as a unit with `oauthRefreshToken`: reconnecting the other
   * way round must not leave the previous kind behind, or the renewal would spend the new
   * credential at the wrong endpoint.
   */
  oauthRenewalKind: connection.refreshToken ? connection.renewalKind : undefined,
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

const genericOAuthKeyVaults = (tokens: {
  accessToken: string;
  accountId?: string;
  expiresIn?: number;
  refreshToken?: string;
  renewalKind?: OAuthRenewalKind;
}) => {
  const expiresAt = tokens.expiresIn
    ? Date.now() + tokens.expiresIn * 1000
    : parseJwtExpiry(tokens.accessToken);
  return {
    oauthAccountId: tokens.accountId,
    oauthAccessToken: tokens.accessToken,
    oauthLastRefreshAt: String(Date.now()),
    oauthLastRefreshErrorAt: undefined,
    oauthRefreshToken: tokens.refreshToken,
    oauthRenewalKind: tokens.refreshToken ? tokens.renewalKind : undefined,
    oauthTokenExpiresAt: expiresAt ? String(expiresAt) : undefined,
  };
};

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
          /**
           * WHICH credential renews it — the PKCE refresh token, or the chatgpt.com web
           * session that mints access tokens the way the web app does. Null when nothing
           * renews it. The stored label wins; connections made before it existed are
           * identified by the credential's shape. Never token material.
           */
          renewalKind: keyVaults.oauthRefreshToken
            ? resolveRenewalKind(keyVaults.oauthRenewalKind, keyVaults.oauthRefreshToken)
            : null,
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
    .mutation(async ({ ctx, input }) => {
      const config = getOAuthConfig(input.providerId);

      if (!config) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Provider ${input.providerId} does not support OAuth Device Flow`,
        });
      }

      const browserProfile = isPasteFlow(input.providerId)
        ? await new PlatformBrowserProfileService(ctx.serverDB).getOrFallback()
        : undefined;
      const service = getOAuthService(
        input.providerId,
        browserProfile ? { browserProfile } : undefined,
      );
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
      z
        .object({
          /**
           * Paste flow only: the pasted redirect URL, or the bare authorization code.
           *
           * `.min(1)` like the admin contract, and not decoration: an empty string is a
           * malformed submit, not "nothing pasted yet", and every gate below reads these
           * fields for truthiness. An empty `callbackUrl` therefore reached the pending
           * branch and answered `pending` where a web-session-only provider owes a
           * `BAD_REQUEST`.
           */
          accessToken: z.string().min(1).max(8192).optional(),
          callbackUrl: z.string().min(1).max(4096).optional(),
          // Same bound as the admin contract: for the paste flow this is a client-held
          // envelope, and an unbounded string would be an unbounded server-side JSON parse.
          deviceCode: z.string().max(8192),
          /**
           * Device id extracted from the paste (`OAI-Device-Id` / `oai-did`). Preferred
           * over the random authorization-envelope id for web-session connections.
           */
          deviceId: chatgptWebDeviceIdSchema.optional(),
          providerId: z.string(),
          /**
           * Original `.0/.1/…` session-cookie values when the paste supplied them.
           */
          sessionChunks: z.array(chatgptWebSessionTokenSchema).min(2).max(8).optional(),
          /**
           * Paste flow only: the chatgpt.com web session cookie (a next-auth JWE). Unlike a
           * bare access token this one RENEWS — it mints fresh access tokens the way the web
           * app does. Same schema as the admin contract: roomier bound (next-auth chunks a
           * large session cookie) and a charset that cannot carry cookie-header delimiters,
           * because this value ends up interpolated into a `Cookie:` header.
           */
          sessionToken: chatgptWebSessionTokenSchema.optional(),
        })
        .superRefine((value, ctx) => {
          if (!value.sessionChunks) return;
          if (!value.sessionToken) {
            ctx.addIssue({
              code: 'custom',
              message: 'sessionChunks requires sessionToken',
              path: ['sessionChunks'],
            });
            return;
          }
          if (value.sessionChunks.join('') !== value.sessionToken) {
            ctx.addIssue({
              code: 'custom',
              message: 'sessionChunks must reassemble sessionToken',
              path: ['sessionChunks'],
            });
          }
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

      const browserProfile = isPasteFlow(input.providerId)
        ? await new PlatformBrowserProfileService(ctx.serverDB).getOrFallback()
        : undefined;
      const service = getOAuthService(
        input.providerId,
        browserProfile ? { browserProfile } : undefined,
      );

      if (isPasteFlow(input.providerId)) {
        if (!(service instanceof ChatGPTWebOAuthService)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} does not support the paste flow`,
          });
        }

        // Nothing pasted yet: the client polls this the same way it polls a device code,
        // but the server does no network work at all until the user acts.
        if (!input.callbackUrl && !input.accessToken && !input.sessionToken) {
          return { status: 'pending' as const };
        }

        /**
         * A web-session-only provider connects through the pasted chatgpt.com session and
         * nothing else: its authorization page asks for the platform API audience and lands
         * on platform.openai.com, which is NOT the subscription this provider serves — a
         * grant redeemed there can be stored and still fail every conversation. The UI no
         * longer offers it; this refuses it for an older client that still would.
         *
         * Only the code exchange is refused. Connections already stored with
         * `oauthRenewalKind: 'oauth'` keep renewing through `refreshAccessToken`.
         */
        if (input.callbackUrl && isProviderWebSessionOnly(input.providerId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} connects only through a pasted web session`,
          });
        }

        // One gate for both pasted-credential kinds: whether a user may hand this provider
        // a credential out of band is one decision, not two.
        if (
          (input.accessToken || input.sessionToken) &&
          !isProviderAccessTokenPasteAllowed(input.providerId)
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} does not accept a pasted credential`,
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
          const existing = await ctx.aiProviderModel.getAiProviderById(
            input.providerId,
            KeyVaultsGateKeeper.getUserKeyVaults,
          );
          const existingDeviceId = (existing?.keyVaults as Record<string, unknown> | undefined)
            ?.oauthDeviceId;
          const connectDeviceId = resolveChatGPTWebConnectDeviceId({
            envelopeDeviceId: envelope.deviceId,
            ...(typeof existingDeviceId === 'string' && existingDeviceId
              ? { existingDeviceId }
              : {}),
            ...(input.deviceId ? { pastedDeviceId: input.deviceId } : {}),
            webSessionOnly: isProviderWebSessionOnly(input.providerId),
          });
          if (
            typeof existingDeviceId === 'string' &&
            existingDeviceId &&
            connectDeviceId &&
            existingDeviceId !== connectDeviceId
          ) {
            wipeChatGPTWebCookieJar(existingDeviceId);
          }
          // Callback URL → PKCE exchange; web session → the renewable paste; access token →
          // the non-renewable fallback. Checked in that order so a paste carrying both a
          // session and a token stores the one that can renew itself.
          connection = input.callbackUrl
            ? await service.exchangeCallback(config, input.deviceCode, input.callbackUrl)
            : input.sessionToken
              ? await service.connectWithSession(input.sessionToken, connectDeviceId, {
                  ...(input.sessionChunks ? { sessionChunks: input.sessionChunks } : {}),
                })
              : await service.verifyAccessToken(input.accessToken!, connectDeviceId);
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

      // Generic OAuth flow (device_code). Providers that also accept a pasted
      // credential (Cursor API key) exchange it here — the paste-flow branch
      // above is authorization-code only.
      if (input.accessToken) {
        if (!isProviderAccessTokenPasteAllowed(input.providerId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Provider ${input.providerId} does not accept a pasted credential`,
          });
        }

        const pollResult = await service.exchangePastedCredential(config, input.accessToken);
        if (pollResult.status === 'success' && pollResult.tokens) {
          await ctx.aiProviderModel.updateConfig(
            input.providerId,
            { keyVaults: genericOAuthKeyVaults(pollResult.tokens) },
            ctx.gateKeeper.encrypt,
            KeyVaultsGateKeeper.getUserKeyVaults,
          );
        }
        return { status: pollResult.status };
      }

      const pollResult = await service.pollForToken(config, input.deviceCode);

      if (pollResult.status === 'success' && pollResult.tokens) {
        await ctx.aiProviderModel.updateConfig(
          input.providerId,
          { keyVaults: genericOAuthKeyVaults(pollResult.tokens) },
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
      if (input.providerId === 'chatgptweb') {
        try {
          const providerDetail = await ctx.aiProviderModel.getAiProviderById(
            input.providerId,
            KeyVaultsGateKeeper.getUserKeyVaults,
          );
          const deviceId = (providerDetail?.keyVaults as Record<string, unknown> | undefined)
            ?.oauthDeviceId;
          wipeChatGPTWebCookieJar(typeof deviceId === 'string' ? deviceId : undefined);
        } catch {
          // Best-effort: a missing jar or a vault read error must not block revoke.
        }
      }

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
            oauthRenewalKind: undefined,
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
