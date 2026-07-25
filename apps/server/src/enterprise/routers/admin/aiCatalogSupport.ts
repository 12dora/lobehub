import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import {
  AiCatalogAdminService,
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from '../../services/aiCatalog/adminService';
import { credentialStringLeaves } from '../../services/aiCatalog/credentialAdapter';
import { sanitizeAiCatalogPersistedText } from '../../services/aiCatalog/persistentText';
import {
  AiCatalogSecretManager,
  type AiSecretMutation,
} from '../../services/aiCatalog/secretManager';
import type { AuditAction } from '../../services/audit/auditActionCatalog';

export const aiSecretMutationRequiresReauth = (mutation?: AiSecretMutation): boolean =>
  mutation?.operation === 'replace' ||
  mutation?.operation === 'merge' ||
  mutation?.operation === 'clear';

const safeDeniedReason = async (params: {
  existingSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: LobeChatDatabase;
  targetId: string;
}): Promise<string | null> => {
  if (containsEnterpriseSecretMaterial(params.reason)) return null;

  const credentials = [...(params.replacementSecrets ?? [])];
  const replacementLeaves = credentials.flatMap(credentialStringLeaves).filter(Boolean);
  if (replacementLeaves.some((value) => params.reason.includes(value))) return null;

  const existingSecretTargetId =
    params.existingSecretTargetId === undefined ? params.targetId : params.existingSecretTargetId;
  if (existingSecretTargetId) {
    try {
      const provider = await new PlatformAiCatalogRepository(params.serverDB).getProvider(
        existingSecretTargetId,
      );
      if (provider?.encryptedKeyVaults) {
        const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise();
        if (!secretService) return null;
        credentials.push(
          await new AiCatalogSecretManager(secretService).decrypt(provider.encryptedKeyVaults),
        );
      }
    } catch {
      return null;
    }
  }

  const reason = sanitizeAiCatalogPersistedText(params.reason, credentials);
  return containsEnterpriseSecretMaterial(reason) ? null : reason;
};

export const createService = (db: LobeChatDatabase): AiCatalogAdminService => {
  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  return new AiCatalogAdminService(db, secrets);
};

export const mapServiceError = (error: unknown): never => {
  if (error instanceof AiCatalogNotFoundError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
    });
  }
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: error.details as Record<string, string | number | boolean | null> | undefined,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof AiCatalogValidationError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { issueCount: error.issues.length },
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  if (error instanceof AiCatalogResourceInUseError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
      details: { dependentCount: error.dependents.length },
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  throw error;
};

export const assertDangerousReauth = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  existingSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: LobeChatDatabase;
  targetId: string;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      resolveDeniedReason: () => safeDeniedReason(params),
      targetId: params.targetId,
      targetType: 'provider',
    },
  });
