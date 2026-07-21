import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertRecentReauth } from '../../guards/reauth';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  PlatformGlobalCredentialAdminService,
  PlatformGlobalCredentialConflictError,
  PlatformGlobalCredentialFileTooLargeError,
  PlatformGlobalCredentialNotFoundError,
  PlatformGlobalCredentialOauthUnsupportedError,
  PlatformGlobalCredentialValidationError,
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
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
};

export const assertDangerousReauth = async (params: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
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
        reason: FIXED_AUDIT_REASON,
        result: 'denied',
        targetId: params.targetId,
        targetType: 'platform_global_credential',
      });
    } catch (auditError) {
      console.error('[admin.creds] reauth denied audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

export { FIXED_AUDIT_REASON };
