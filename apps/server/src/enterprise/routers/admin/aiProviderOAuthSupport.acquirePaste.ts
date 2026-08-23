import {
  isProviderAccessTokenPasteAllowed,
  isProviderWebSessionOnly,
} from 'model-bank/modelProviders';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { OAuthDeviceFlowService } from '@/server/services/oauthDeviceFlow';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  ChatGPTWebOAuthError,
  ChatGPTWebOAuthService,
  parsePasteEnvelope,
  resolveChatGPTWebConnectDeviceId,
} from '../../services/chatgptWeb/oauthService';
import type {
  AcquireSharedConnectionOutcome,
  AcquireSharedConnectionParams,
} from './aiProviderOAuthSupport.acquireTypes';
import { unfinishedPollResult } from './aiProviderOAuthSupport.acquireTypes';
import { auditProvider } from './aiProviderOAuthSupport.card';
import { toSharedTokens } from './aiProviderOAuthSupport.vault';

/**
 * Authorization-code paste path: callback URL, web session, or pasted access token.
 * Operator-fixable outcomes are reported with a stable code and never audit the paste.
 */
export const acquireAuthorizationCodePasteTokens = async ({
  actorUserId,
  audit,
  card,
  existingDeviceId,
  input,
  oauthService,
  targetId,
}: AcquireSharedConnectionParams & {
  oauthService: OAuthDeviceFlowService;
}): Promise<AcquireSharedConnectionOutcome> => {
  if (!(oauthService instanceof ChatGPTWebOAuthService)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  // Nothing pasted yet: the operator has not finished signing in. No network work,
  // no audit row — the client may poll this the same way it polls a device code.
  if (!input.callbackUrl && !input.accessToken && !input.sessionToken) {
    return { kind: 'result', result: { ...unfinishedPollResult, status: 'pending' as const } };
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
  if (input.callbackUrl && isProviderWebSessionOnly(input.id)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  // One gate for BOTH pasted-credential kinds: whether an operator may hand this
  // provider a credential out of band is one decision, not two.
  if ((input.accessToken || input.sessionToken) && !isProviderAccessTokenPasteAllowed(input.id)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  try {
    // Both branches REQUIRE a live envelope: it carries the PKCE verifier for the
    // code exchange and the device id the authorize call was made with. A malformed
    // or stale one is reported (`invalid_callback` / `expired`) rather than silently
    // minting a fresh device id, which would break the sentinel handshake the stored
    // `oai-device-id` is supposed to keep stable.
    const envelope = parsePasteEnvelope(input.deviceCode);
    const webSessionOnly = isProviderWebSessionOnly(input.id);
    const connectDeviceId = resolveChatGPTWebConnectDeviceId({
      envelopeDeviceId: envelope.deviceId,
      ...(existingDeviceId ? { existingDeviceId } : {}),
      ...(input.deviceId ? { pastedDeviceId: input.deviceId } : {}),
      webSessionOnly,
    });
    // Callback URL → PKCE exchange; web session → the renewable paste; access token →
    // the non-renewable fallback. Checked in that order so a paste carrying both a
    // session and a token stores the one that can renew itself.
    const connection = input.callbackUrl
      ? await oauthService.exchangeCallback(card.config, input.deviceCode, input.callbackUrl)
      : input.sessionToken
        ? await oauthService.connectWithSession(input.sessionToken, connectDeviceId, {
            ...(input.sessionChunks ? { sessionChunks: input.sessionChunks } : {}),
          })
        : await oauthService.verifyAccessToken(input.accessToken!, connectDeviceId);
    return {
      kind: 'tokens',
      tokens: toSharedTokens(connection),
      ...(oauthService instanceof ChatGPTWebOAuthService ? { browserSession: oauthService } : {}),
    };
  } catch (error) {
    // Operator-fixable outcomes (bad paste, stale envelope, rejected exchange) are
    // reported with a stable code — the pasted callback carries a live authorization
    // code and must never be audited or logged.
    if (error instanceof ChatGPTWebOAuthError) {
      await auditProvider(audit, {
        action: 'admin.aiProviderOAuth.pollAuthStatus',
        actorUserId,
        afterDiff: { error: error.code, providerKey: input.id },
        result: 'failure',
        targetId,
      });
      return {
        kind: 'result',
        result: { ...unfinishedPollResult, error: error.code, status: 'error' as const },
      };
    }
    await auditProvider(audit, {
      action: 'admin.aiProviderOAuth.pollAuthStatus',
      actorUserId,
      afterDiff: { error: 'device_token_exchange_failed', providerKey: input.id },
      result: 'failure',
      targetId,
    });
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
};
