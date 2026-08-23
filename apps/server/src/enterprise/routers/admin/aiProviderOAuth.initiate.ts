import {
  getProviderOAuthGrantFlow,
  isProviderAccessTokenPasteAllowed,
} from 'model-bank/modelProviders';
import type { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getOAuthService } from '@/server/services/oauthDeviceFlow/providers/githubCopilot';

import type { adminAiProviderOAuthInitiateInputSchema } from '../../contracts/aiProviderOAuth';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { PlatformBrowserProfileService } from '../../services/browserProfile';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth } from './aiCatalogSupport';
import type { AiProviderOAuthCtx } from './aiProviderOAuth.ctx';
import {
  auditProvider,
  INITIATE_REAUTH_REASON,
  resolveRotatingOAuthCard,
} from './aiProviderOAuthSupport';

type InitiateInput = z.infer<typeof adminAiProviderOAuthInitiateInputSchema>;

export const initiateSharedDeviceCode = async ({
  ctx,
  input,
}: {
  ctx: AiProviderOAuthCtx;
  input: InitiateInput;
}) => {
  // Admission first: an unsupported provider is rejected before any audit row exists.
  const card = resolveRotatingOAuthCard(input.id);

  await assertDangerousReauth({
    action: 'admin.aiProviderOAuth.initiateDeviceCode',
    actorUserId: ctx.userId!,
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    // Constant reason, no stored secret to scan against.
    existingSecretTargetId: null,
    reason: INITIATE_REAUTH_REASON,
    serverDB: ctx.serverDB,
    targetId: input.id,
  });

  const audit = new PlatformAuditService(ctx.serverDB);

  let response;
  try {
    const browserProfile =
      getProviderOAuthGrantFlow(input.id) === 'authorization_code_paste'
        ? await new PlatformBrowserProfileService(ctx.serverDB).getOrFallback()
        : undefined;
    response = await getOAuthService(
      input.id,
      browserProfile ? { browserProfile } : undefined,
    ).initiateDeviceCode(card.config);
  } catch {
    await auditProvider(audit, {
      action: 'admin.aiProviderOAuth.initiateDeviceCode',
      actorUserId: ctx.userId!,
      // Provider prose may echo request material — only a stable code is stored.
      afterDiff: { error: 'device_code_request_failed', providerKey: input.id },
      result: 'failure',
      targetId: input.id,
    });
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  await auditProvider(audit, {
    action: 'admin.aiProviderOAuth.initiateDeviceCode',
    actorUserId: ctx.userId!,
    afterDiff: { providerKey: input.id },
    result: 'success',
    targetId: input.id,
  });

  return {
    allowAccessTokenPaste: isProviderAccessTokenPasteAllowed(input.id),
    deviceCode: response.deviceCode,
    expiresIn: Number.isFinite(response.expiresIn) ? response.expiresIn : null,
    flow: getProviderOAuthGrantFlow(input.id),
    interval: response.interval,
    userCode: response.userCode,
    verificationUri: response.verificationUri,
    verificationUriComplete: response.verificationUriComplete ?? null,
  };
};
