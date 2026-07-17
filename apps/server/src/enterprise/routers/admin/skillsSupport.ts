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
import { assertRecentReauth } from '../../guards/reauth';
import { PlatformAuditService } from '../../services/platformAudit';
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
        targetType: 'skill',
      });
    } catch (auditError) {
      console.error('[admin.skills] reauth denied audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};
