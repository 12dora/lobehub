import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertRecentReauth } from '../../guards/reauth';
import {
  AiCatalogAdminService,
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from '../../services/aiCatalog/adminService';
import { PlatformAuditService } from '../../services/platformAudit';

export const createService = (db: LobeChatDatabase): AiCatalogAdminService => {
  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) {
    throwEnterpriseError({
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
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
  targetId: string;
}) => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: params.reason,
        result: 'denied',
        targetId: params.targetId,
        targetType: 'provider',
      });
    } catch (auditError) {
      console.error('[admin.aiCatalog] reauth denied audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};
