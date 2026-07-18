import { TRPCError } from '@trpc/server';
import debug from 'debug';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertRecentReauth } from '../../guards/reauth';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentDependencyValidationError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
  PlatformAgentUnavailableError,
} from '../../services/agentCatalog';
import { PlatformAuditService } from '../../services/platformAudit';

const log = debug('lobe-server:admin-agents');

export const assertAgentFeatureEnabled = () => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      httpCode: 'FORBIDDEN',
    });
  }
};

export const mapAgentServiceError = (error: unknown): never => {
  if (error instanceof PlatformAgentNotFoundError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      httpCode: 'NOT_FOUND',
    });
  }
  if (error instanceof PlatformAgentRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      httpCode: 'CONFLICT',
    });
  }
  if (error instanceof PlatformAgentDependencyValidationError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { issueCount: error.issueCodes.length },
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  if (error instanceof PlatformAgentDefaultRequiredError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_DEFAULT_AGENT_REQUIRED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
  if (error instanceof PlatformAgentResourceInUseError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
      httpCode: 'CONFLICT',
    });
  }
  // Normalized (redacted) unique / foreign-key / trigger conflicts and rejected
  // default-flag mutations. Detail-free: no constraint, target, or offending value.
  if (error instanceof PlatformAgentInvalidInputError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      httpCode: 'BAD_REQUEST',
    });
  }
  // Already-redacted unknown read failure (REWORK-5). Surface a stable, detail-free 500 rather
  // than re-throwing a raw driver error at the boundary.
  if (error instanceof PlatformAgentUnavailableError) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Platform temporarily unavailable',
    });
  }
  log(
    'unmapped Agent service error redacted class=%s',
    error instanceof Error ? error.name : 'UnknownError',
  );
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Platform temporarily unavailable',
  });
};

export const assertAgentDangerousReauth = async (params: {
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
        targetType: 'agent',
      });
    } catch (auditError) {
      log(
        'reauth denied audit failed class=%s',
        auditError instanceof Error ? auditError.name : 'UnknownError',
      );
    }
    throw error;
  }
};
