import { getProviderOAuthGrantFlow } from 'model-bank/modelProviders';
import type { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import type { adminAiProviderOAuthStatusInputSchema } from '../../contracts/aiProviderOAuth';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { AiCatalogNotFoundError } from '../../services/aiCatalog/adminService';
import { providerCredentialKeys } from '../../services/aiCatalog/credentialAdapter';
import { AiCatalogSecretManager } from '../../services/aiCatalog/secretManager';
import { tryBackfillSharedAccountIdentity } from '../../services/aiCatalog/sharedOAuthIdentity';
import { createService, mapServiceError } from './aiCatalogSupport';
import type { AiProviderOAuthCtx } from './aiProviderOAuth.ctx';
import {
  maskAccountId,
  projectSharedConnectionStatus,
  refreshStatusVault,
  resolveRotatingOAuthCard,
} from './aiProviderOAuthSupport';

type StatusInput = z.infer<typeof adminAiProviderOAuthStatusInputSchema>;

export const getSharedConnectionStatus = async ({
  ctx,
  input,
}: {
  ctx: AiProviderOAuthCtx;
  input: StatusInput;
}) => {
  resolveRotatingOAuthCard(input.id);

  const disconnected = {
    accountEmail: null,
    accountIdMasked: null,
    canRefresh: false,
    connected: false,
    expired: false,
    expiresAt: null,
    flow: getProviderOAuthGrantFlow(input.id),
    invalidAt: null,
    invalidReason: null,
    needsReauth: false,
    renewalKind: null,
    secretConfigured: false,
  };

  let detail;
  try {
    detail = await createService(ctx.serverDB).getDetail({ providerKey: input.id });
  } catch (error) {
    if (error instanceof AiCatalogNotFoundError) return disconnected;
    return mapServiceError(error);
  }

  const secretConfigured = detail.draft.secret.configured;
  if (!secretConfigured) return disconnected;

  const provider = await new PlatformAiCatalogRepository(ctx.serverDB).getProvider(detail.draft.id);
  if (!provider?.encryptedKeyVaults) {
    return { ...disconnected, secretConfigured };
  }

  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  const secretManager = new AiCatalogSecretManager(secrets);
  const keyVaults = await secretManager.decrypt(provider.encryptedKeyVaults);

  // Renew before projecting. Rotation used to happen ONLY on a real chat execution, so an
  // operator opening this card saw a stale (often already expired) timestamp until someone
  // chatted. This runs the same lease + CAS machinery, and is a cheap no-op while the
  // token is still fresh.
  const refreshed = await refreshStatusVault({
    db: ctx.serverDB,
    keyVaults,
    provider: {
      encryptedKeyVaults: provider.encryptedKeyVaults,
      id: provider.id,
      secretFingerprint: provider.secretFingerprint,
    },
    providerKey: input.id,
    secretManager,
  });

  const status = projectSharedConnectionStatus({
    expired: refreshed.expired,
    flow: getProviderOAuthGrantFlow(input.id),
    keyVaults: refreshed.keyVaults,
    providerKey: input.id,
    secretConfigured,
  });

  if (
    status.connected &&
    !status.accountEmail &&
    providerCredentialKeys(input.id).has('oauthAccountEmail')
  ) {
    try {
      const backfilled = await tryBackfillSharedAccountIdentity({
        db: ctx.serverDB,
        providerKey: input.id,
        providerRowId: provider.id,
        secrets: secretManager,
      });
      if (backfilled?.email) status.accountEmail = backfilled.email;
      if (backfilled?.accountId) status.accountIdMasked = maskAccountId(backfilled.accountId);
    } catch {
      // Identity backfill must never take the status card down.
    }
  }

  return status;
};
