import { builtinTools } from '@lobechat/builtin-tools';
import { ZodError } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  PlatformRevisionConflictError,
  PlatformSkillBuiltinOverrideError,
  PlatformSkillChecksumMismatchError,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import {
  getBuiltinSkillDefinitions,
  SkillCatalogAdminService,
  SkillCatalogInvalidCursorError,
  SkillCatalogNotFoundError,
  SkillCatalogValidationError,
} from '../../services/skillCatalog';

export const assertSkillFeatureEnabled = () => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_SKILLS) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
    });
  }
};

export const createSkillService = (db: LobeChatDatabase) => {
  assertSkillFeatureEnabled();
  const builtinSkills = getBuiltinSkillDefinitions();
  return new SkillCatalogAdminService(db, {
    allowBuiltinOverride: true,
    builtinSkillKeys: new Set(builtinSkills.map((skill) => skill.skillKey)),
    builtinSkills,
    knownToolKeys: new Set(builtinTools.map((tool) => tool.identifier)),
  });
};

export const mapSkillServiceError = (error: unknown): never => {
  if (error instanceof SkillCatalogNotFoundError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
    });
  }
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: error.details as Record<string, boolean | null | number | string> | undefined,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof SkillCatalogInvalidCursorError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      httpCode: 'BAD_REQUEST',
    });
  }
  if (
    error instanceof SkillCatalogValidationError ||
    error instanceof ZodError ||
    error instanceof PlatformSkillChecksumMismatchError ||
    error instanceof PlatformSkillBuiltinOverrideError
  ) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: {
        issueCount:
          error instanceof SkillCatalogValidationError || error instanceof ZodError
            ? error.issues.length
            : 1,
      },
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  throw error;
};

export const assertSkillDangerousReauth = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason?: string | null;
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
      reason: params.reason,
      targetId: params.targetId,
      targetType: 'skill',
    },
  });
