import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { logModerationFailure } from './contentModerationSupport';

export const mapModerationError = (error: unknown): never => {
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
  if (error instanceof Error && error.message === 'Unknown IANA time zone') {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'timezone', reason: 'unknown_timezone' },
    });
  }
  if (error instanceof Error && error.message.startsWith('Unknown IANA time zone:')) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'timezone', reason: 'unknown_timezone' },
    });
  }
  logModerationFailure('unexpected operation failure', error, 'operation_failed');
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { reason: 'operation_failed' },
    httpCode: 'INTERNAL_SERVER_ERROR',
  });
};
