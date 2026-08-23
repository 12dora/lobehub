import { TRPCError } from '@trpc/server';
import { after } from 'next/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  IdentityProviderSystemError,
  IdentityProviderSystemService,
} from '../../services/identityProvider/systemService';
import { InfraSettingsSecretRequiredError } from '../../services/infraSettings';
import { InfraSettingsDestinationError } from '../../services/infraSettings/destinationPolicy';
import { InfraSettingsSecretReuseError } from '../../services/infraSettings/errors';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from '../../services/platformSystem/errors';

export const createSystemService = (
  db: ConstructorParameters<typeof IdentityProviderSystemService>[0],
) => new IdentityProviderSystemService(db, undefined, undefined, (task) => after(task));

export const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityProviderSystemError) {
      if (error.code === 'PLATFORM_IDENTITY_RESTART_UNSUPPORTED') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_UNSUPPORTED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (error.code === 'PLATFORM_IDENTITY_RESTART_NOT_PENDING') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_NOT_PENDING,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (error.code === 'PLATFORM_IDENTITY_RESTART_INTENT_EXPIRED') {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_INTENT_EXPIRED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      if (
        error.code === 'PLATFORM_IDENTITY_RESTART_INTENT_INVALID' ||
        error.code === 'PLATFORM_IDENTITY_RESTART_CONFLICT'
      ) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_INTENT_INVALID,
          httpCode: 'CONFLICT',
        });
      }
    }
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }
};

export const executePlatformSystem = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PlatformSystemJobNotFoundError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }
    if (error instanceof PlatformSystemJobConflictError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        httpCode: 'CONFLICT',
      });
    }
    if (error instanceof PlatformSystemJobInvalidError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        httpCode: 'BAD_REQUEST',
      });
    }
    if (error instanceof PlatformRevisionConflictError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        details: {
          currentRevision: error.details?.currentRevision ?? null,
          expectedRevision: error.details?.expectedRevision ?? null,
          resourceId: error.details?.resourceId ?? null,
        },
        httpCode: 'CONFLICT',
      });
    }
    if (
      error instanceof InfraSettingsSecretRequiredError ||
      error instanceof InfraSettingsSecretReuseError
    ) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        details: { field: error.field },
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
    if (error instanceof InfraSettingsDestinationError) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED,
        details: { field: error.field },
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
    console.error('[admin.system] operation unavailable', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Platform temporarily unavailable',
    });
  }
};
