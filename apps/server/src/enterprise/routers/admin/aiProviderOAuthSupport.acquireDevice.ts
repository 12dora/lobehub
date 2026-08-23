import { isProviderAccessTokenPasteAllowed } from 'model-bank/modelProviders';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { OAuthDeviceFlowService, TokenResponse } from '@/server/services/oauthDeviceFlow';
import { parseJwtExpiry } from '@/server/services/oauthDeviceFlow';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { ChatGPTWebOAuthService } from '../../services/chatgptWeb/oauthService';
import type {
  AcquireSharedConnectionOutcome,
  AcquireSharedConnectionParams,
} from './aiProviderOAuthSupport.acquireTypes';
import { unfinishedPollResult } from './aiProviderOAuthSupport.acquireTypes';
import { auditProvider } from './aiProviderOAuthSupport.card';
import type { SharedConnectionTokens } from './aiProviderOAuthSupport.vault';

/**
 * Expiry: prefer the explicit expires_in, fall back to the JWT exp claim —
 * some providers (e.g. xAI) don't always return expires_in.
 */
export const toDevicePollSharedTokens = (tokens: TokenResponse): SharedConnectionTokens => {
  const expiresAt = tokens.expiresIn
    ? Date.now() + tokens.expiresIn * 1000
    : parseJwtExpiry(tokens.accessToken);
  return {
    accessToken: tokens.accessToken,
    ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.renewalKind ? { renewalKind: tokens.renewalKind } : {}),
  };
};

/** RFC 8628 device-code poll, or the pasted-access-token shortcut for the same grant. */
export const acquireDevicePollTokens = async ({
  actorUserId,
  audit,
  card,
  input,
  oauthService,
  targetId,
}: AcquireSharedConnectionParams & {
  oauthService: OAuthDeviceFlowService;
}): Promise<AcquireSharedConnectionOutcome> => {
  let pollResult;
  try {
    if (input.accessToken) {
      if (!isProviderAccessTokenPasteAllowed(input.id)) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      pollResult = await oauthService.exchangePastedCredential(card.config, input.accessToken);
    } else {
      pollResult = await oauthService.pollForToken(card.config, input.deviceCode);
    }
  } catch {
    await auditProvider(audit, {
      action: 'admin.aiProviderOAuth.pollAuthStatus',
      actorUserId,
      // Provider prose may echo request material — only a stable code is stored.
      afterDiff: { error: 'device_token_exchange_failed', providerKey: input.id },
      result: 'failure',
      targetId,
    });
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  if (pollResult.status !== 'success' || !pollResult.tokens) {
    return { kind: 'result', result: { ...unfinishedPollResult, status: pollResult.status } };
  }

  return {
    kind: 'tokens',
    tokens: toDevicePollSharedTokens(pollResult.tokens),
    ...(oauthService instanceof ChatGPTWebOAuthService ? { browserSession: oauthService } : {}),
  };
};
