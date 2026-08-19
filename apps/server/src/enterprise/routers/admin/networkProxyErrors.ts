import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';

import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { resolveEngineIssueCode } from '../../services/networkProxy/engine/errors';

export const sanitizeLocalError = (error: unknown, _redact: (text: string) => string): string =>
  resolveEngineIssueCode(error);

export const mapNetworkProxyError = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: error.details as Record<string, string | number | boolean | null> | undefined,
    });
  }
  if (error instanceof z.ZodError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { issueCount: error.issues.length },
    });
  }

  const body = getEnterpriseErrorBody(error);
  if (body?.code) {
    throw error;
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code && code in PLATFORM_ERROR_CODES) {
      return throwEnterpriseError({
        code: code as keyof typeof PLATFORM_ERROR_CODES,
        details:
          'details' in error
            ? ((error as { details?: Record<string, string | number | boolean | null> }).details ??
              undefined)
            : undefined,
      });
    }
  }

  if (error instanceof Error) {
    const message = error.message;
    if (message in PLATFORM_ERROR_CODES) {
      return throwEnterpriseError({
        code: message as keyof typeof PLATFORM_ERROR_CODES,
      });
    }
  }

  console.error('[admin.networkProxy] unexpected operation failure', {
    errorClass: error instanceof Error ? error.name : 'UnknownError',
  });
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { reason: 'operation_failed' },
    httpCode: 'INTERNAL_SERVER_ERROR',
  });
};
