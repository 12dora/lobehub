import {
  DEFAULT_MODEL_PROVIDER_LIST,
  isRotatingRefreshOAuthProvider,
} from 'model-bank/modelProviders';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import type {
  AppendPlatformAuditLogParams,
  PlatformAuditService,
} from '../../services/platformAudit';

export interface RotatingOAuthProviderCard {
  /** Builtin default probe model, seeded so admin connectivity check works on first connect. */
  checkModel?: string;
  config: OAuthDeviceFlowConfig;
  description?: string;
  name: string;
  settings: Record<string, unknown>;
}

/**
 * Resolve the builtin card of a provider whose device flow issues ROTATING refresh
 * tokens. Only these providers may hold a shared platform account: an API-key style
 * credential is never valid for them, and whoever stores the token owns its refresh
 * lifecycle. Everything else (including GitHub Copilot) is rejected here.
 */
export const resolveRotatingOAuthCard = (providerKey: string): RotatingOAuthProviderCard => {
  const card = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === providerKey);
  const config = card?.settings?.oauthDeviceFlow;

  if (!card || !config || !isRotatingRefreshOAuthProvider(providerKey)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  return {
    checkModel: card.checkModel,
    config,
    description: card.description,
    name: card.name,
    settings: (card.settings ?? {}) as Record<string, unknown>,
  };
};

/**
 * Reason recorded on the reauth denial of the initiate step. The contract carries no
 * operator reason there (nothing is persisted), so a server constant is used — it can
 * never contain secret material.
 */
export const INITIATE_REAUTH_REASON =
  'Request a device authorization code for a shared provider account.';

/**
 * The device grant is single-use and every branch below reaches the shared platform
 * credential, so both procedures require the union of the create and update branches.
 * Create-vs-update is decided by server state (does the platform row exist yet), not by
 * client input, and an operator who may open the flow must be able to finish it.
 */
export const sharedAccountPermissions = [
  PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
] as const;

/**
 * Withdrawing the shared account only ever UPDATES an existing row and publishes the
 * result — it can never create one. AI_PROVIDER_CREATE is deliberately NOT required:
 * gating the withdrawal of a live shared credential behind a permission the operation
 * does not use would leave an operator unable to stop it. Nothing is deleted either
 * (the provider row survives), so AI_PROVIDER_DELETE is equally wrong.
 */
export const disconnectPermissions = [
  PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
] as const;

export const auditProvider = (
  audit: PlatformAuditService,
  params: Omit<AppendPlatformAuditLogParams, 'targetType'>,
) => audit.append({ ...params, targetType: 'provider' });
