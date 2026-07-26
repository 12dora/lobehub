import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import {
  PlatformGlobalCredentialAdminService,
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialOauthUnsupportedError,
  PlatformGlobalCredentialValidationError,
  PlatformRevisionConflictError,
} from '../../services/platformGlobalCredentials/adminService';

const FIXED_AUDIT_REASON = 'platform_global_credential_mutation';

export const createCredsService = (db: LobeChatDatabase): PlatformGlobalCredentialAdminService => {
  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  return new PlatformGlobalCredentialAdminService(db, secrets);
};

export const mapCredsServiceError = (error: unknown): never => {
  if (error instanceof PlatformGlobalCredentialNotFoundError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
      message: error.message,
    });
  }
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
      message: error.message,
    });
  }
  if (error instanceof PlatformGlobalCredentialConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'CONFLICT',
      message: error.message,
    });
  }
  if (error instanceof PlatformGlobalCredentialFileTooLargeError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { maxBytes: error.maxBytes },
      httpCode: 'BAD_REQUEST',
      message: error.message,
    });
  }
  if (error instanceof PlatformGlobalCredentialOauthUnsupportedError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'BAD_REQUEST',
      message: error.message,
    });
  }
  if (error instanceof PlatformGlobalCredentialValidationError) {
    if (
      error.validationCode === PLATFORM_ERROR_CODES.PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID
    ) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID,
        httpCode: 'BAD_REQUEST',
      });
    }
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: error.validationCode ? { validationCode: error.validationCode } : undefined,
      httpCode: 'BAD_REQUEST',
    });
  }
  throw error;
};

export const assertDangerousReauth = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
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
      reason: FIXED_AUDIT_REASON,
      targetId: params.targetId,
      targetType: 'platform_global_credential',
    },
  });
